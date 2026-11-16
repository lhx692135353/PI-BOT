import assert from "node:assert/strict";
import test from "node:test";
import { Hub, type DeviceConnection } from "../src/hub.js";
import type { Row, Tx } from "../src/db.js";
import { browserTestRouting, resolveTaskTarget } from "../src/targets.js";

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
  assert.equal((await route({})).device_id, first.device_id);
  attach(second);
  await assert.rejects(route({}), /Home PC|Work Mac/);
  const pinned = await route({ source_device_id: first.device_id }, loopback);
  assert.equal(pinned.execution, "device");
  assert.equal(pinned.device_id, first.device_id);
  assert.deepEqual(pinned.requirements, ["browser-test"]);
  assert.equal((await route({}, loopback, undefined, [{target: `device:${second.device_id}`}])).device_id, second.device_id);
  await assert.rejects(route({}, loopback, first.device_id, [{target: `device:${second.device_id}`}]), /项目所在电脑不同/);
  hub.detach(current);
  await assert.rejects(route({ source_device_id: first.device_id }, loopback), /请在聊天中确认使用哪台电脑/);
  assert.equal((await route({ source_device_id: first.device_id })).device_id, second.device_id);
  await assert.rejects(resolveTaskTarget(tx, undefined, hub, user, "tester", pinned), /电脑已离线/);
  await assert.rejects(resolveTaskTarget(tx, undefined, hub, user, "tester", { ...pinned, execution: "remote" }), /已选定的用户电脑/);
});
