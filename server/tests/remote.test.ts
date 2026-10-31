import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  symlink,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { posix } from "node:path";
import ssh2 from "ssh2";
import { settings } from "../src/config.js";
import { Database, type Row } from "../src/db.js";
import { createApp } from "../src/app.js";
import { RemoteService } from "../src/remote/service.js";
import { connectSsh, fingerprint } from "../src/remote/transport.js";
import {
  Kubevirt,
  vmCredentials,
  vmResources,
} from "../src/remote/kubevirt.js";
import { ensureEnvironment } from "../src/remote/environments.js";
import { Hub } from "../src/hub.js";
import { issueLlmToken, Vault } from "../src/security.js";
import { createBot, insertRun, finishRun } from "../src/bots.js";
import { createTask, startTask } from "../src/agents.js";
import {
  AutomationScheduler,
  manageGoals,
  saveGoalDecision,
  goalRequest,
} from "../src/automations.js";
import { claimExecution } from "../src/scheduling.js";
import { createRunner } from "../src/runner.js";
import { Worker } from "../src/worker.js";
import {
  tempDir,
  vaultFile,
  TEST_DB,
  resetDatabase,
  eventually,
} from "./helpers.js";

const envBase = {
  PI_BOT_DATABASE_URL: "postgresql://unused",
  PI_BOT_JWT_SECRET: "j".repeat(40),
};
test("remote backend is disabled by default and kubevirt rejects missing startup credentials", () => {
  assert.equal(settings(envBase).remoteBackend, "none");
  assert.throws(() => settings({ ...envBase, PI_BOT_REMOTE_BACKEND: "both" }));
  assert.throws(() =>
    settings({ ...envBase, PI_BOT_REMOTE_BACKEND: "kubevirt" }),
  );
});
test("vault domains isolate SSH secrets from model credentials", () => {
  const dir = tempDir();
  try {
    const file = vaultFile(dir.path),
      id = randomUUID(),
      sealed = new Vault(file, "remote").seal("ssh-password", id);
    assert.equal(new Vault(file, "remote").open(sealed, id), "ssh-password");
    assert.throws(() => new Vault(file).open(sealed, id));
  } finally {
    dir.cleanup();
  }
});
test("SSH verifies host fingerprints and exchanges guest RPC over an actual SSH channel", async () => {
  const pair = ssh2.utils.generateKeyPairSync("ed25519"),
    key = ssh2.utils.parseKey(pair.private);
  assert.ok(!(key instanceof Error));
  const server = new ssh2.Server({ hostKeys: [pair.private] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) =>
      ctx.username === "pibot" &&
      ctx.method === "password" &&
      ctx.password === "secret"
        ? ctx.accept()
        : ctx.reject(),
    );
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (accept, _reject, info) => {
          assert.equal(info.command, "node /opt/pibot-remote/client.mjs");
          const stream = accept();
          let input = "";
          stream.on("data", (b: Buffer) => (input += b));
          stream.on("end", () => {
            assert.equal(JSON.parse(input).action, "health");
            stream.write(JSON.stringify({ result: { version: 1 } }));
            stream.exit(0);
            stream.end();
          });
        });
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  try {
    const config = {
      host: "127.0.0.1",
      port,
      username: "pibot",
      fingerprint: fingerprint(key.getPublicSSH()),
      work_root: "/home/pibot/workspaces",
    };
    const client = await connectSsh(config, { password: "secret" });
    try {
      assert.deepEqual(await client.call({ action: "health" }), { version: 1 });
    } finally {
      client.close();
    }
    await assert.rejects(
      connectSsh(
        { ...config, fingerprint: "SHA256:" + "A".repeat(43) },
        { password: "secret" },
      ),
      /SSH/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("guest sandbox resolves directory links before enforcing approved paths", async () => {
  const modulePath = new URL("../remote-guest/core.mjs", import.meta.url).href;
  const core = await import(modulePath),
    dir = await mkdtemp(join(tmpdir(), "pibot-guest-"));
  try {
    const root = join(dir, "bot"),
      outside = join(dir, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "secret");
    // Directory junctions exercise realpath containment without Windows symlink privileges.
    await symlink(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(core.resolvePath(root, "link/secret"), /超出/);
    assert.equal(
      await core.resolvePath(root, "link/secret", [
        await core.realPath(outside),
      ]),
      await core.realPath(join(outside, "secret")),
    );
    await assert.rejects(core.resolvePath(root, "../outside/secret"), /超出/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("guest command timeout and cancellation stop POSIX process groups", {
  skip: process.platform === "win32" && "Ubuntu guest commands require /bin/bash and POSIX process groups",
}, async () => {
  const core = await import(new URL("../remote-guest/core.mjs", import.meta.url).href);
  const root = await mkdtemp(join(tmpdir(), "pibot-guest-command-"));
  try {
    const result = await core.command(
      "printf ok; sleep 5",
      root,
      30,
      new AbortController().signal,
    );
    assert.equal(result.timed_out, true);
    assert.equal(result.output, "ok");
    const c = new AbortController(),
      pending = core.command("sleep 5", root, 5000, c.signal);
    c.abort();
    assert.equal((await pending).cancelled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("KubeVirt resources use persistent disks, separate credentials and stable names; conflicts never adopt another owner", async () => {
  const config = {
    ...settings(envBase).kubevirt,
    server: "https://cluster",
    imageUrl: "https://images/example.qcow2",
    timeoutSeconds: 1,
  };
  const id = randomUUID(),
    creds = vmCredentials(),
    r = vmResources(id, config, creds);
  assert.equal(r.vm.spec.runStrategy, "Always");
  assert.equal(r.disk.spec.pvc.resources.requests.storage, "40Gi");
  assert.ok(!JSON.stringify(r.vm).includes(creds.private_key));
  assert.ok(JSON.stringify(r.secret).includes("ssh_keys"));
  const store = new Map<string, any>();
  let creates = 0;
  class FakeKube extends Kubevirt {
    async api(path: string, method = "GET", body?: any) {
      if (path.includes("virtualmachineinstances"))
        return { status: 200, body: { status: { phase: "Running" } } };
      if (method === "POST") {
        const key = path + "/" + body.metadata.name;
        if (store.has(key)) return { status: 409, body: {} };
        store.set(key, body);
        creates++;
        return { status: 201, body };
      }
      return store.has(path)
        ? { status: 200, body: store.get(path) }
        : { status: 404, body: {} };
    }
  }
  const provider = new FakeKube(config);
  await Promise.all([provider.ensure(id, creds), provider.ensure(id, creds)]);
  assert.equal(creates, 3);
  const secret = [...store.keys()].find((k) => k.includes("/secrets/"))!;
  store.get(secret).metadata.labels["pibot.io/environment"] = "other";
  await assert.rejects(provider.ensure(id, creds), /归属/);
});

const skip = !TEST_DB && "需要 PI_BOT_TEST_DATABASE_URL";
let app: Awaited<ReturnType<typeof createApp>>,
  db: Database,
  hub: Hub,
  s: ReturnType<typeof settings>,
  token: string,
  userId: string,
  botId: string,
  envId: string,
  otherUser: string;
let service: RemoteService;
let dir: ReturnType<typeof tempDir>;
const operations: any[] = [],
  ports: number[] = [];
let sftpFactory: () => Promise<any> = async () => {
  throw new Error("SFTP fixture not configured");
};
const fakeConnection = {
  call: async (q: any, signal?: AbortSignal): Promise<any> => {
    operations.push(q);
    if (q.action === "health")
      return {
        version: 1,
        capabilities: ["shell", "files", "browser", "desktop", "vnc"],
      };
    if (q.action === "run_command" && q.args.command === "block")
      return new Promise((_, reject) =>
        signal?.addEventListener(
          "abort",
          () => reject(new Error("操作已取消")),
          { once: true },
        ),
      );
    if (q.action === "run_command")
      return { exit_code: 0, output: "remote-ok", timed_out: false };
    if (q.action === 'validate_approval') return {path:q.args.path,resource_type:'directory'};
    if (q.action === "desktop_screenshot")
      return {
        path: "/home/pibot/workspaces/test/outputs/screen.png",
        image: { mime: "image/png", data: "aGVsbG8=" },
      };
    return { ok: true };
  },
  sftp: () => sftpFactory(),
  forward: async (port: number) => {
    ports.push(port);
    return new PassThrough();
  },
  close() {},
};
before(async () => {
  if (skip) return;
  await resetDatabase(TEST_DB!);
  dir = tempDir();
  s = settings({
    ...envBase,
    PI_BOT_DATABASE_URL: TEST_DB,
    PI_BOT_ADMIN_PASSWORD: "test-password",
    PI_BOT_VAULT_FILE: vaultFile(dir.path),
    PI_BOT_REMOTE_BACKEND: "ssh",
    PI_BOT_RUNNER_TOKEN: "r".repeat(40),
  });
  db = new Database(TEST_DB!);
  hub = new Hub();
  app = await createApp(
    s,
    db,
    hub,
    undefined,
    (db, s) => (service = new RemoteService(db, s, async () => fakeConnection)),
  );
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "admin", password: "test-password" },
  });
  token = login.json().access_token;
  userId = login.json().user.id;
  await db.tx(async (tx) => {
    await tx.insert("models", {
      model_id: randomUUID(),
      name: "test",
      base_url: "http://127.0.0.1:1/v1",
      provider_model: "test",
      context_window: 32000,
      max_tokens: 1000,
      secret: {},
    });
    botId = (await createBot(tx, userId, { name: "test", persona: "" })).bot_id;
    otherUser = randomUUID();
    await tx.insert("users", {
      user_id: otherUser,
      username: "other",
      password_hash: "unused",
      role: "user",
    });
  });
  const configured = await api(`/admin/api/users/${userId}/environment`, {
    config: { host: "example.test", fingerprint: "SHA256:" + "A".repeat(43) },
    secret: { password: "ssh-secret" },
  });
  assert.equal(configured.statusCode, 200, configured.body);
  envId = configured.json().id;
});
after(async () => {
  if (skip) return;
  await app?.close();
  dir?.cleanup();
});
async function api(url: string, payload?: any, bearer = token) {
  return app.inject({
    method: payload ? "POST" : "GET",
    url,
    headers: { authorization: "Bearer " + bearer },
    payload,
  });
}
async function run(
  target = "remote:" + envId,
  lane: "conversation" | "task" = "task",
): Promise<Row> {
  return db.tx(async (tx) => {
    const b = await createBot(tx, userId, {
      name: "case-" + randomUUID().slice(0, 8),
      persona: "",
    });
    const r = await insertRun(tx, {
      userId,
      botId: b.bot_id,
      requestId: randomUUID(),
      text: "test",
      computer: null,
      lane,
      operationTarget: target,
      sourceClient: "android",
    });
    await tx.rows("UPDATE bot_runs SET status='running' WHERE run_id=$1", [
      r.run_id,
    ]);
    return { ...r, status: "running" };
  });
}
async function llm(r: Row) {
  return issueLlmToken({ sub: userId, src: "cloud", bot: r.bot_id }, s);
}

test('remembered remote read scopes are matched per operation and revoked within an active run', {skip}, async()=>{
  const first = await run(), firstToken = await llm(first), path = '/srv/projects/demo';
  const waiting = api('/agent/remote/action',{run_id:first.run_id,call_id:randomUUID(),action:'request_outside_access',args:{path,reason:'读取项目',access:'read'}},firstToken);
  const pending = await eventually(()=>db.tx(tx=>tx.one("SELECT * FROM approvals WHERE run_id=$1 AND status='pending'",[first.run_id])));
  const grant = await api(`/approvals/${pending.approval_id}`,{decision:'approve_always'});
  assert.equal(grant.statusCode,200,grant.body);
  const finished = await waiting; assert.equal(finished.statusCode,200,finished.body); assert.equal(finished.json().approved,true);
  const rules = (await api('/authorizations')).json();
  const rule = rules.find((r:any)=>r.target === `remote:${envId}` && r.resource === path);
  assert.ok(rule);
  const next = await run(), nextToken = await llm(next);
  const request = async(action:string,args:object)=>{
    const response = await api('/agent/remote/action',{run_id:next.run_id,call_id:randomUUID(),action,args},nextToken);
    assert.equal(response.statusCode,200,response.body);return response.json();
  };
  const savedRequest = {run_id:next.run_id,call_id:randomUUID(),action:'request_outside_access',args:{path,reason:'再次读取'}};
  const savedResult = await api('/agent/remote/action',savedRequest,nextToken);
  assert.equal(savedResult.statusCode,200,savedResult.body);
  assert.equal(savedResult.json().remembered,true);
  const replay = await api('/agent/remote/action',savedRequest,nextToken);
  assert.equal(replay.statusCode,200,replay.body);
  assert.deepEqual(replay.json(),savedResult.json(),'saved-scope requests complete their operation record for safe retries');
  await request('read_file',{path:path+'/readme.txt'}); assert.deepEqual(operations.at(-1).approved,[path]);
  await request('write_file',{path:path+'/readme.txt',content:'change'}); assert.deepEqual(operations.at(-1).approved,[],'read grant must not reach a mutating guest operation');
  await request('run_command',{command:'echo ok',cwd:path}); assert.deepEqual(operations.at(-1).approved,[]);
  const revoked = await app.inject({method:'DELETE',url:`/authorizations/${rule.id}`,headers:{authorization:`Bearer ${token}`}});
  assert.equal(revoked.statusCode,200,revoked.body);
  await request('read_file',{path:path+'/readme.txt'}); assert.deepEqual(operations.at(-1).approved,[],'revocation is rechecked in the same run');
  for(const r of [first,next])await db.tx(tx=>finishRun(tx,r.run_id,'completed',null));
});
test(
  "remote configuration never returns credentials and requires ownership",
  { skip },
  async () => {
    const result = await api(`/admin/api/users/${userId}/environment`);
    assert.ok(!result.body.includes("ssh-secret"));
    const unknown = await db.tx((tx) =>
      tx.one("SELECT secret FROM remote_environments WHERE environment_id=$1", [
        envId,
      ]),
    );
    assert.ok(!JSON.stringify(unknown).includes("ssh-secret"));
    await assert.rejects(
      db.tx((tx) =>
        import("../src/remote/environments.js").then((m) =>
          m.ownEnvironment(tx, s, otherUser, envId),
        ),
      ),
      /不存在/,
    );
  },
);
test(
  "Android tasks dispatch automatically to cloud when no computer is available; explicit targets never fall back",
  { skip },
  async () => {
    const parent = await run("remote", "conversation"),
      claims = { sub: userId, src: "cloud" as const, bot: parent.bot_id };
    const result = await db.tx((tx) =>
      createTask(
        tx,
        hub,
        userId,
        claims,
        {
          run_id: parent.run_id,
          task: "do work",
          kind: "background",
          wait: false,
          request_id: randomUUID(),
        },
        s,
      ),
    );
    assert.equal(result.task.operation_target,"pending");
    await service.connect(await db.tx(tx=>tx.get("remote_environments",envId)));
    const dispatched=await db.tx(async tx=>startTask(tx,hub,await tx.get("agent_tasks",result.task.id),s));
    assert.equal(dispatched?.operation_target,"remote:"+envId);
    assert.equal(dispatched?.executor,"cloud");
    const plain = await db.tx((tx) =>
      createTask(
        tx,
        hub,
        userId,
        claims,
        {
          run_id: parent.run_id,
          task: "text",
          execution: "cloud",
          kind: "background",
          wait: false,
          request_id: randomUUID(),
        },
        s,
      ),
    );
    assert.equal(plain.task.operation_target, "cloud");
    const id = randomUUID();
    await db.tx((tx) =>
      tx.insert("devices", {
        device_id: id,
        user_id: userId,
        label: "Offline",
        public_key: "test",
      }),
    );
    await assert.rejects(
      db.tx((tx) =>
        createTask(
          tx,
          hub,
          userId,
          claims,
          {
            run_id: parent.run_id,
            task: "local",
            execution: "device",
            device_id: id,
            kind: "background",
            wait: false,
          },
          s,
        ),
      ),
      /离线/,
    );
    await db.tx(async (tx) => {
      await finishRun(tx, dispatched!.run_id, "cancelled", null);
      await finishRun(tx, plain.run!.run_id, "cancelled", null);
      await finishRun(tx, parent.run_id, "completed", null);
    });
  },
);
test(
  "cloud operation routes enforce run targets, preserve uncertain results and do not replay tool calls",
  { skip },
  async () => {
    const r = await run(),
      t = await llm(r),
      payload = {
        run_id: r.run_id,
        call_id: "command-1",
        action: "run_command",
        args: { command: "echo ok" },
      };
    const before = operations.length,
      first = await api("/agent/remote/action", payload, t);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().output, "remote-ok");
    assert.equal(
      (await api("/agent/remote/action", payload, t)).statusCode,
      200,
    );
    assert.equal(
      operations.slice(before).filter((x) => x.action === "run_command").length,
      1,
    );
    const other = await run("cloud");
    assert.equal(
      (
        await api(
          "/agent/remote/action",
          { ...payload, run_id: other.run_id },
          await llm(other),
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await api(
          "/agent/remote/action",
          { ...payload, call_id: "bad", args: {} },
          t,
        )
      ).statusCode,
      422,
    );
    await db.tx((tx) =>
      tx.rows(
        "INSERT INTO remote_operations(run_id,call_id,action) VALUES($1,'uncertain','run_command')",
        [r.run_id],
      ),
    );
    assert.equal(
      (
        await api(
          "/agent/remote/action",
          { ...payload, call_id: "uncertain" },
          t,
        )
      ).statusCode,
      409,
    );
    await db.tx(async (tx) => {
      await finishRun(tx, r.run_id, "completed", null);
      await finishRun(tx, other.run_id, "completed", null);
    });
    await service.releaseRun(r.run_id);
  },
);
test(
  "manual takeover cancels commands, excludes other tasks and requires a new screenshot before continuing",
  { skip },
  async () => {
    const env = await db.tx((tx) => tx.get("remote_environments", envId)),
      r = await run();
    const work = service.action(env, r, "test", "block", "run_command", {
      command: "block",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const rejected = assert.rejects(work, /取消/);
    const lease = await service.acquire(env);
    await rejected;
    await assert.rejects(
      service.action(env, r, "test", "blocked", "desktop_input", {
        type: "click",
      }),
      /人工接管/,
    );
    const viewing = await service.desktop(env, undefined);
    assert.equal(ports.at(-1), 5902);
    viewing.stream.destroy();
    const controlling = await service.desktop(env, lease.id);
    assert.equal(ports.at(-1), 5901);
    controlling.stream.destroy();
    service.release(envId, lease.id);
    await assert.rejects(
      service.action(env, r, "test", "stale", "desktop_input", {
        type: "click",
      }),
      /先重新截图/,
    );
    await service.action(env, r, "test", "read", "desktop_screenshot", {});
    await service.action(env, r, "test", "click", "desktop_input", {
      type: "click",
    });
    const r2 = await run();
    await assert.rejects(
      service.action(env, r2, "test2", "busy", "browser", {
        op: "open",
        url: "https://example.com",
      }),
      /另一任务/,
    );
    await db.tx(async (tx) => {
      await finishRun(tx, r.run_id, "completed", null);
      await finishRun(tx, r2.run_id, "completed", null);
    });
    await service.releaseRun(r.run_id);
  },
);
test(
  "goals on different machines form independent reviews and cloud reviews can be claimed by a worker",
  { skip },
  async () => {
    const parent = await run("remote", "conversation"),
      claims = { sub: userId, src: "cloud" as const, bot: parent.bot_id };
    const id = randomUUID();
    await db.tx((tx) =>
      tx.insert("devices", {
        device_id: id,
        user_id: userId,
        label: "Local",
        public_key: randomUUID(),
      }),
    );
    hub.attach({
      userId,
      deviceId: id,
      capabilities: ["always-on-v1","files","shell"],
      send() {},
      close() {},
    });
    for (const execution of ["remote", "device"] as const)
      await db.tx((tx) =>
        manageGoals(
          tx,
          userId,
          claims,
          goalRequest.parse({
            run_id: parent.run_id,
            action: "create",
            request_id: randomUUID(),
            goal: "Goal " + execution,
            authorization: "own workspace",
            execution,
            device_id: execution === "device" ? id : undefined,
          }),
          new Date(),
          s,
          hub,
        ),
      );
    const reviews = await db.tx((tx) =>
      tx.rows("SELECT * FROM bot_automations WHERE bot_id=$1", [parent.bot_id]),
    );
    assert.equal(reviews.length, 2);
    await db.tx(async (tx) => {
      await finishRun(tx, parent.run_id, "completed", null);
      await tx.rows(
        "UPDATE bot_automations SET next_wake_at=now() WHERE bot_id=$1",
        [parent.bot_id],
      );
    });
    const scheduler = new AutomationScheduler(db, s, hub);
    const remote = await eventually(async () => {
      await scheduler.once();
      return db.tx((tx) =>
        tx.one(
          "SELECT * FROM bot_runs WHERE bot_id=$1 AND origin='automation' AND operation_target LIKE 'remote:%'",
          [parent.bot_id],
        ),
      );
    });
    assert.ok(remote);
    assert.ok(
      await eventually(() =>
        db.tx((tx) => claimExecution(tx, remote!.run_id, s, randomUUID())),
      ),
    );
    const goals = await db.tx((tx) =>
      tx.rows(
        "SELECT g.* FROM bot_goals g JOIN bot_automations a ON a.bot_id=g.bot_id AND a.operation_target=g.operation_target WHERE g.bot_id=$1 AND a.automation_id=$2",
        [parent.bot_id, remote!.automation_id],
      ),
    );
    await db.tx((tx) =>
      saveGoalDecision(tx, userId, claims, {
        run_id: remote!.run_id,
        decision: {
          goals: goals.map((g) => ({
            id: g.goal_id,
            state: "continue" as const,
            progress: "checked",
            notify: false,
            reason: "same",
          })),
        },
      }),
    );
    const active = await db.tx((tx) =>
      tx.rows(
        "SELECT * FROM bot_runs WHERE bot_id=$1 AND origin='automation'",
        [parent.bot_id],
      ),
    );
    for (const r of active)
      await db.tx((tx) => finishRun(tx, r.run_id, "cancelled", null));
    hub.detach(hub.device(userId, id)!);
  },
);
test(
  "concurrent KubeVirt environment reservation creates one durable set of keys",
  { skip },
  async () => {
    const ks = { ...s, remoteBackend: "kubevirt" as const };
    const all = await Promise.all(
      Array.from({ length: 6 }, () =>
        db.tx((tx) => ensureEnvironment(tx, ks, otherUser)),
      ),
    );
    assert.equal(new Set(all.map((e) => e.environment_id)).size, 1);
    assert.equal(new Set(all.map((e) => e.secret.ciphertext)).size, 1);
  },
);
test(
  "real Runner and Worker route remote tools through the API and persist their result",
  { skip },
  async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
    const runner = await createRunner({
      token: s.runnerToken!,
      dir: dir.path,
      factory: async (options) => ({
        tools: options.tools.map((x) => x.name),
        setApiKey: async () => {},
        abort: async () => {},
        dispose() {},
        prompt: async () => {
          assert.ok(options.tools.some((t) => t.name === "browser"));
          assert.ok(options.tools.some((t) => t.name === "desktop_screenshot"));
          const tool = options.tools.find((t) => t.name === "run_command")!;
          const result = await tool.execute(
            "worker-op",
            { command: "printf remote" },
            undefined,
            undefined,
            {} as any,
          );
          return result.content
            .filter((x) => x.type === "text")
            .map((x) => (x as any).text)
            .join("");
        },
      }),
    });
    await runner.listen({ host: "127.0.0.1", port: 0 });
    const ws = {
      ...s,
      internalUrl: base,
      runnerUrl: `http://127.0.0.1:${(runner.server.address() as any).port}`,
    };
    const worker = new Worker(db, ws);
    try {
      const pending = await db.tx((tx) =>
        tx.rows("SELECT run_id FROM bot_runs WHERE status='queued'"),
      );
      for (const item of pending)
        await db.tx((tx) => finishRun(tx, item.run_id, "cancelled", null));
      const r = await run();
      await db.tx((tx) =>
        tx.rows("UPDATE bot_runs SET status='queued' WHERE run_id=$1", [
          r.run_id,
        ]),
      );
      // Earlier tasks can enqueue reports concurrently with this test's job.
      const saved = await eventually(async () => {
        await worker.runOnce();
        const current = await db.tx(tx => tx.get("bot_runs", r.run_id));
        return ["completed", "failed", "cancelled"].includes(current.status) && current;
      });
      assert.equal(saved.status, "completed", saved.error);
      const message = await db.tx((tx) =>
        tx.get("bot_messages", r.assistant_message_id),
      );
      assert.match(message.content, /remote-ok/);
    } finally {
      worker.stop();
      await runner.close();
    }
  },
);
test(
  "desktop assets, scoped artifact links and streaming SFTP uploads stay within the authorized bot",
  { skip },
  async () => {
    const bot = await db.tx((tx) => tx.get("bots", botId)),
      root = "/home/pibot/workspaces/" + bot.slug;
    const files = new Map<string, Buffer>(),
      directories = new Set(["/home/pibot/workspaces", root]);
    let ended = 0;
    sftpFactory = async () => ({
      realpath(path: string, cb: Function) {
        if (files.has(path) || directories.has(path)) cb(null, path);
        else cb(new Error("not found"));
      },
      createWriteStream(path: string) {
        const chunks: Buffer[] = [];
        return new Writable({
          write(chunk, _encoding, done) {
            chunks.push(Buffer.from(chunk));
            done();
          },
          final(done) {
            files.set(path, Buffer.concat(chunks));
            done();
          },
        });
      },
      createReadStream(path: string) {
        return Readable.from([files.get(path)!]);
      },
      ext_openssh_rename(from: string, to: string, cb: Function) {
        files.set(to, files.get(from)!);
        files.delete(from);
        cb(null);
      },
      unlink(path: string, cb: Function) {
        files.delete(path);
        cb(null);
      },
      end() {
        ended++;
      },
    });
    try {
      assert.equal(
        (await app.inject({ url: "/remote-desktop/" })).statusCode,
        200,
      );
      assert.match(
        (await app.inject({ url: "/remote-desktop/novnc/core/rfb.js" })).body,
        /RFB/,
      );
      const opened = await api("/remote/desktop/open", { bot_id: botId });
      assert.equal(opened.statusCode, 200, opened.body);
      const launch = new URL("http://test" + opened.json().url),
        ticket = new URLSearchParams(launch.hash.slice(1)).get("token")!;
      const sessionApi = (payload: object) =>
        app.inject({
          method: "POST",
          url: "/remote-desktop/session",
          headers: {
            authorization: "Bearer " + ticket,
            "content-type": "application/json",
          },
          payload,
        });
      assert.equal(
        (
          await sessionApi({
            action: "text",
            session_id: randomUUID(),
            text: "中文",
          })
        ).statusCode,
        409,
      );
      const acquired = await sessionApi({ action: "acquire" });
      assert.equal(acquired.statusCode, 200, acquired.body);
      assert.equal(
        (
          await sessionApi({
            action: "text",
            session_id: acquired.json().session_id,
            text: "中文",
          })
        ).statusCode,
        200,
      );
      await sessionApi({
        action: "release",
        session_id: acquired.json().session_id,
      });
      const fileUrl = "/remote-desktop/file?bot=" + botId + "&path=hello.txt";
      const headers = {
        authorization: "Bearer " + ticket,
        "content-type": "application/octet-stream",
      };
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: fileUrl,
            headers,
            payload: Buffer.from("文件内容"),
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (await app.inject({ url: fileUrl, headers })).body,
        "文件内容",
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: fileUrl,
            headers,
            payload: Buffer.from("updated"),
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (await app.inject({ url: fileUrl, headers })).body,
        "updated",
      );
      assert.ok(ended >= 4);
      assert.equal(
        (
          await app.inject({
            url: "/remote-desktop/file?bot=" + botId + "&path=../outside",
            headers,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            url: "/remote-desktop/file?bot=" + randomUUID() + "&path=hello.txt",
            headers,
          })
        ).statusCode,
        403,
      );
      const artifact = randomUUID();
      await db.tx((tx) =>
        tx.insert("remote_artifacts", {
          artifact_id: artifact,
          user_id: userId,
          bot_id: botId,
          environment_id: envId,
          path: root + "/hello.txt",
          name: "hello.txt",
        }),
      );
      const view = await api(`/remote/artifacts/${artifact}/open`, {});
      assert.equal(view.statusCode, 200);
      const scoped = new URLSearchParams(view.json().url.split("#")[1]).get(
        "token",
      )!;
      assert.equal(
        (
          await app.inject({
            url:
              "/remote-desktop/file?bot=" +
              botId +
              "&path=" +
              encodeURIComponent(root + "/hello.txt"),
            headers: { authorization: "Bearer " + scoped },
          })
        ).body,
        "updated",
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/remote-desktop/session",
            headers: {
              authorization: "Bearer " + scoped,
              "content-type": "application/json",
            },
            payload: { action: "acquire" },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            url: "/remote-desktop/file?bot=" + botId + "&path=another.txt",
            headers: { authorization: "Bearer " + scoped },
          })
        ).statusCode,
        403,
      );
    } finally {
      sftpFactory = async () => {
        throw new Error("not used");
      };
    }
  },
);
test(
  "takeover waits for the guest cancellation acknowledgement before granting control",
  { skip },
  async () => {
    const env = await db.tx((tx) => tx.get("remote_environments", envId)),
      r = await run();
    const original = fakeConnection.call;
    let acknowledge!: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    fakeConnection.call = async (q: any, signal?: AbortSignal) => {
      if (q.action === "cancel") {
        await acknowledged;
        return { ok: true };
      }
      return original(q, signal);
    };
    try {
      const work = service.action(
        env,
        r,
        "test",
        "cancel-confirm",
        "run_command",
        { command: "block" },
      );
      await eventually(() =>
        operations.some((q) => q.operation_id === r.run_id + ":cancel-confirm"),
      );
      const stopped = assert.rejects(work, /取消/);
      let granted = false;
      const acquiring = service.acquire(env).then((value) => {
        granted = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(granted, false);
      acknowledge();
      const lease = await acquiring;
      await stopped;
      service.release(envId, lease.id);
      await service.releaseRun(r.run_id);
      await db.tx((tx) => finishRun(tx, r.run_id, "cancelled", null));
    } finally {
      acknowledge();
      fakeConnection.call = original;
    }
  },
);
