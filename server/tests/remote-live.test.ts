import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { connectSsh } from "../src/remote/transport.js";
const host = process.env.PI_BOT_REMOTE_TEST_HOST;
/** Opt-in against an administrator-prepared Ubuntu guest. Never defaults to a real host. */
test(
  "Ubuntu guest: files, shell, browser, screenshot and read-only/control desktop forwarding",
  { skip: !host && "需要显式配置 PI_BOT_REMOTE_TEST_HOST" },
  async () => {
    const c = await connectSsh(
      {
        host: host!,
        port: Number(process.env.PI_BOT_REMOTE_TEST_PORT ?? 22),
        username: process.env.PI_BOT_REMOTE_TEST_USER ?? "pibot",
        fingerprint: process.env.PI_BOT_REMOTE_TEST_FINGERPRINT!,
        work_root: "/home/pibot/workspaces",
      },
      {
        private_key: process.env.PI_BOT_REMOTE_TEST_KEY
          ? await readFile(process.env.PI_BOT_REMOTE_TEST_KEY, "utf8")
          : undefined,
        password: process.env.PI_BOT_REMOTE_TEST_PASSWORD,
      },
    );
    const slug = "acceptance-" + randomUUID().slice(0, 8),
      call = (action: string, args: object = {}) =>
        c.call({ operation_id: randomUUID(), slug, action, args });
    try {
      assert.equal(
        (await c.call({ action: "health", operation_id: randomUUID() }))
          .version,
        1,
      );
      await call("write_file", {
        path: "index.html",
        content:
          '<button id="test" onclick="this.textContent=\'clicked\'">test</button><input id="input">',
      });
      assert.match(
        (await call("read_file", { path: "index.html" })).content,
        /button/,
      );
      await call("run_command", {
        command:
          'nohup python3 -m http.server 18973 --bind 127.0.0.1 --directory "$PWD" >server.log 2>&1 </dev/null & echo $! >server.pid',
      });
      await call("browser", { op: "open", url: "http://127.0.0.1:18973" });
      await call("browser", {
        op: "fill",
        selector: "#input",
        text: "中文测试",
      });
      await call("browser", { op: "click", selector: "#test" });
      assert.match((await call("browser", { op: "read" })).text, /clicked/);
      const image = await call("desktop_screenshot");
      assert.equal(image.image.mime, "image/png");
      assert.ok(image.image.data.length > 100);
      for (const port of [5901, 5902]) {
        const stream = await c.forward(port);
        stream.destroy();
      }
    } finally {
      await call("browser", { op: "close" }).catch(() => {});
      await call("run_command", {
        command:
          'test ! -f server.pid || kill "$(cat server.pid)"; rm -f server.pid',
      }).catch(() => {});
      c.close();
    }
  },
);
