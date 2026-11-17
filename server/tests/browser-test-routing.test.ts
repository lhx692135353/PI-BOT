import assert from "node:assert/strict";
import test from "node:test";
import { Hub, type DeviceConnection } from "../src/hub.js";
import type { Row, Tx } from "../src/db.js";
import { browserTestOriginInMessage, browserTestRouting, electronTestRouting, resolveTaskTarget } from "../src/targets.js";

test("the user-provided URL authorizes only its exact origin", () => {
  const origin = "https://staging.example.test";
  assert.equal(browserTestOriginInMessage("测一下 [注册](https://staging.example.test/register)。", origin), true);
  assert.equal(browserTestOriginInMessage("测试 http://[::1]:3000/hello", "http://[::1]:3000"), true);
  assert.equal(browserTestOriginInMessage("测试 https://staging.example.test:8443/a", origin), false);
  assert.equal(browserTestOriginInMessage("测试 https://other.test/?redirect=https://staging.example.test", origin), false);
  assert.equal(browserTestOriginInMessage("测试 https://staging.example.test@other.test/a", origin), false);
});

test("browser-test routing chooses an eligible computer and pins its destination", async () => {
  const user = "owner";
  const first = { device_id: "11111111-1111-4111-8111-111111111111", label: "Work Mac" };
  const second = { device_id: "22222222-2222-4222-8222-222222222222", label: "Home PC" };
  const lan = "https://test.example";
  const loopback = "http://localhost:3000";
  const origins = new Map([[first.device_id, new Set([lan, loopback])], [second.device_id, new Set([lan, loopback])]]);
  const hub = new Hub();
  const attach = ({ device_id }: typeof first) => {
    const conn: DeviceConnection = {
      userId: user, deviceId: device_id, capabilities: ["browser-test"], close() {},
      send(message) {
        if (message.type !== "rpc") return;
        assert.equal(message.method, "browser-test.preflight");
        hub.resolveRpc(device_id, { id: message.id, ok: true, result: { available: origins.get(device_id)?.has(message.params.origin) } });
      },
    };
    hub.attach(conn);
    return conn;
  };
  const tx = {
    rows: async () => [first, second],
    one: async (query: string) => query.includes("SELECT source_device_id") ? undefined : { exists: true },
  } as unknown as Tx;
  const route = (source: Row, origin = lan, deviceId?: string, resources?: {target: string}[]) =>
    browserTestRouting(tx, undefined, hub, user, source, { browser_test_origin: origin, device_id: deviceId, resources, requirements: ["browser"] });
  const current = attach(first);
  await assert.rejects(route({}), /请确认测试项目/);
  attach(second);
  await assert.rejects(route({}), /请确认测试项目/);
  const pinned = await route({ source_device_id: first.device_id }, loopback, first.device_id);
  assert.equal(pinned.execution, "device");
  assert.equal(pinned.device_id, first.device_id);
  assert.deepEqual(pinned.requirements, ["browser-test"]);
  assert.equal((await route({}, loopback, undefined, [{target: `device:${second.device_id}`}])).device_id, second.device_id);
  await assert.rejects(route({}, loopback, first.device_id, [{target: `device:${second.device_id}`}]), /项目所在电脑不同/);
  hub.detach(current);
  await assert.rejects(route({ source_device_id: first.device_id }, loopback), /请确认测试项目/);
  await assert.rejects(route({ source_device_id: first.device_id }), /请确认测试项目/);
  await assert.rejects(resolveTaskTarget(tx, undefined, hub, user, "tester", pinned), /电脑已离线/);
  await assert.rejects(resolveTaskTarget(tx, undefined, hub, user, "tester", { ...pinned, execution: "remote" }), /已选定的用户电脑/);
});

test("Electron tests choose a capable desktop and keep local targets pinned", async () => {
  const a = { device_id: "11111111-1111-4111-8111-111111111111", label: "Mac" };
  const b = { device_id: "22222222-2222-4222-8222-222222222222", label: "Windows" };
  const user = "owner";
  const hub = new Hub();
  const tx = { rows: async () => [a, b], one: async () => ({ exists: true }) } as unknown as Tx;
  const connect = (device: typeof a, builtIn = false) => hub.attach({
    userId: user, deviceId: device.device_id,
    capabilities: ["electron-test-v1", ...(builtIn ? ["pibot-electron-test-v1"] : [])],
    send() {}, close() {},
  });
  connect(a, true);
  connect(b);
  const app = { electron_test: { app: "electron" as const, executable: "test-app" } };
  await assert.rejects(electronTestRouting(tx, hub, user, {}, app), /请确认应用/);
  const generic = await electronTestRouting(tx, hub, user, { source_device_id: b.device_id }, {...app,device_id:b.device_id});
  assert.equal(generic.device_id, b.device_id);
  const builtIn = await electronTestRouting(tx, hub, user, {}, { electron_test: { app: "pibot" },device_id:a.device_id });
  assert.equal(builtIn.device_id, a.device_id);
  assert.equal((await resolveTaskTarget(tx, undefined, hub, user, "test", builtIn)).execution, "device");
  const pinned = await electronTestRouting(tx, hub, user, {}, { ...app, resources: [{ target: `device:${a.device_id}` }] });
  assert.equal(pinned.device_id, a.device_id);
  await assert.rejects(electronTestRouting(tx, hub, user, {}, { ...app, execution: "remote" }), /用户电脑/);
  await assert.rejects(resolveTaskTarget(tx, undefined, hub, user, "test", { ...builtIn, device_id: b.device_id }), /pibot-electron-test-v1/);
});
