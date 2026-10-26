import {
  createHash,
  createPublicKey,
  verify,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { hash, verify as verifyPassword, argon2id } from "argon2";
import { HttpError, fail, type Tx, type Row } from "./db.js";
import type { Settings } from "./config.js";
export const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const passwordHash = (password: string) =>
  hash(password, {
    type: argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });
export async function passwordMatches(hashed: string, password: string) {
  try {
    return await verifyPassword(hashed, password);
  } catch {
    return false;
  }
}
const secret = (s: Settings) => new TextEncoder().encode(s.jwtSecret);
/** One-minute credential so a desktop renderer can open `/ws/voice` without the provider key. */
export const issueVoiceTicket = (userId: string, botId: string, s: Settings, source?:{client:string;deviceId?:string}) =>
  new SignJWT({ typ: "voice", bot: botId, client:source?.client, did:source?.deviceId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
    .sign(secret(s));
export async function readVoiceTicket(token: string, s: Settings) {
  const payload = await verifyToken(token, s, "voice");
  const botId = payload.bot;
  const userId = payload.sub;
  if (typeof botId !== "string" || typeof userId !== "string") throw new HttpError(401, "认证失败");
  return { userId, botId, client:typeof payload.client==="string"?payload.client:"legacy", deviceId:typeof payload.did==="string"?payload.did:undefined };
}
export const issueToken = (u: Row, s: Settings) =>
  new SignJWT({ typ: "user", role: u.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(u.user_id)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + s.jwtTtl)
    .sign(secret(s));
export interface LlmClaims {
  sub: string;
  src: "device" | "cloud" | "memory" | "test";
  bot?: string;
  did?: string;
}
/** Short-lived bearer for the model proxy. Provider keys never leave the server. */
export const issueLlmToken = (claims: LlmClaims, s: Settings, ttl = s.llmTokenTtl) =>
  new SignJWT({ typ: "llm", src: claims.src, bot: claims.bot, did: claims.did })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(secret(s));
async function verifyToken(value: string, s: Settings, typ: string) {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(value, secret(s), { algorithms: ["HS256"] }));
  } catch {
    return fail(401, "认证失败");
  }
  if (payload.typ !== typ || !payload.sub || !payload.exp) fail(401, "认证失败");
  return payload;
}
function bearer(headers: Row) {
  const m = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? "");
  return m?.[1];
}
async function activeUser(tx: Tx, id: string) {
  const u = await tx.get("users", id);
  if (!u || u.disabled) fail(401, "账号不可用");
  return u;
}
export async function user(tx: Tx, headers: Row, s: Settings) {
  const token = bearer(headers);
  if (!token) fail(401, "需要认证");
  const payload = await verifyToken(token!, s, "user");
  return activeUser(tx, payload.sub!);
}
export async function llmCaller(tx: Tx, headers: Row, s: Settings) {
  const token = bearer(headers);
  if (!token) fail(401, "需要认证");
  const payload = await verifyToken(token!, s, "llm");
  const u = await activeUser(tx, payload.sub!);
  if (!["device","cloud","memory","test"].includes(String(payload.src))) fail(401,"请升级执行端并重新登录");
  if (payload.src === "device" && !await tx.one("SELECT 1 FROM devices WHERE device_id=$1 AND user_id=$2 AND revoked_at IS NULL",[payload.did,payload.sub])) fail(401,"设备已解绑");
  return { user: u, claims: payload as unknown as LlmClaims };
}
export function decodeBase64(value: string, size?: number) {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error("Base64");
  const b = Buffer.from(value, "base64");
  if (size && b.length !== size) throw new Error("length");
  return b;
}
export const DEVICE_HEADERS = {
  id: "x-pibot-device-id",
  timestamp: "x-pibot-timestamp",
  nonce: "x-pibot-nonce",
  signature: "x-pibot-signature",
} as const;
export const isSigned = (headers: Row) => !!headers[DEVICE_HEADERS.signature];
export async function device(
  tx: Tx,
  headers: Row,
  method: string,
  path: string,
  body: Buffer,
  s: Settings,
) {
  if (headers.authorization) fail(400, "不能同时使用用户令牌和设备签名");
  const id = headers[DEVICE_HEADERS.id],
    timestamp = headers[DEVICE_HEADERS.timestamp],
    nonce = headers[DEVICE_HEADERS.nonce],
    signature = headers[DEVICE_HEADERS.signature];
  if (
    !/^[0-9a-f-]{36}$/i.test(id ?? "") ||
    !/^-?\d+$/.test(timestamp ?? "") ||
    !nonce ||
    nonce.length < 16 ||
    nonce.length > 128 ||
    !signature ||
    signature.length > 512 ||
    Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) >
      s.signatureSkew
  )
    fail(401, "设备认证失败");
  const d = await tx.get("devices", id);
  if (!d || d.revoked_at) fail(401, "设备认证失败");
  try {
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        decodeBase64(d.public_key, 32),
      ]),
      format: "der",
      type: "spki",
    });
    if (
      !verify(
        null,
        Buffer.from(
          `${timestamp}.${nonce}.${method.toUpperCase()}.${path}.${sha256(body)}`,
        ),
        key,
        decodeBase64(signature, 64),
      )
    )
      fail(401, "设备认证失败");
  } catch {
    fail(401, "设备认证失败");
  }
  await tx.rows("DELETE FROM device_nonces WHERE expires_at < now()");
  const saved = await tx.one(
    "INSERT INTO device_nonces(device_id,nonce,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING nonce",
    [id, nonce, new Date((Number(timestamp) + s.signatureSkew) * 1000)],
  );
  if (!saved) fail(401, "设备认证失败");
  const owner = await activeUser(tx, d.user_id);
  return { device: d, user: owner };
}
export class Vault {
  private keys!: Record<string, string>;
  private active!: string;
  constructor(path?: string, private domain = "model") {
    try {
      const d = JSON.parse(readFileSync(path!, "utf8"));
      this.keys = d.keys;
      this.active = d.active;
      if (
        !this.keys[this.active] ||
        Object.values(this.keys).some((k) => decodeBase64(k, 32).length !== 32)
      )
        throw new Error();
    } catch {
      return fail(503, "模型密钥不可用：请检查服务端加密密钥文件");
    }
  }
  seal(value: string, id: string) {
    const nonce = randomBytes(12),
      c = createCipheriv(
        "aes-256-gcm",
        decodeBase64(this.keys[this.active], 32),
        nonce,
      );
    c.setAAD(Buffer.from(`${this.domain}:${id}`));
    const ciphertext = Buffer.concat([
      c.update(value, "utf8"),
      c.final(),
      c.getAuthTag(),
    ]);
    return {
      key_id: this.active,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }
  open(value: Row, id: string): string {
    try {
      const b = decodeBase64(value.ciphertext),
        d = createDecipheriv(
          "aes-256-gcm",
          decodeBase64(this.keys[value.key_id], 32),
          decodeBase64(value.nonce, 12),
        );
      d.setAAD(Buffer.from(`${this.domain}:${id}`));
      d.setAuthTag(b.subarray(-16));
      return Buffer.concat([d.update(b.subarray(0, -16)), d.final()]).toString(
        "utf8",
      );
    } catch {
      return fail(503, "模型密钥无法解密，请检查加密密钥");
    }
  }
}
