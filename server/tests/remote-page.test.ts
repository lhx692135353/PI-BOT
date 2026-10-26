import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("remote desktop page boots in view mode and sends human text only after acquiring a lease", async () => {
  const html = await readFile(
    new URL("../remote-guest/desktop.html", import.meta.url),
    "utf8",
  );
  const script = html
    .match(/<script type="module">([\s\S]*?)<\/script>/)![1]
    .replace(/import RFB from [^;]+;/, "");
  class Element {
    value = "";
    hidden = false;
    disabled = false;
    textContent = "";
    onclick?: () => unknown;
    onchange?: () => unknown;
    append() {}
    replaceChildren() {}
    removeAttribute() {}
  }
  const elements = new Map(
    [...html.matchAll(/id="([^"]+)"/g)].map((m) => ["#" + m[1], new Element()]),
  );
  const calls: any[] = [];
  class RFB {
    viewOnly = false;
    scaleViewport = false;
    resizeSession = false;
    constructor(_element: unknown, url: string) {
      assert.match(url, /\/ws\/remote-desktop\?ticket=/);
    }
    disconnect() {}
    addEventListener(name: string, callback: Function) {
      if (name === "connect") callback();
    }
  }
  const context = {
    RFB,
    URL,
    URLSearchParams,
    location: {
      href: "https://example.test/pibot/remote-desktop/#token=scope&bot=bot-id",
      hash: "#token=scope&bot=bot-id",
      pathname: "/pibot/remote-desktop/",
      protocol: "https:",
    },
    history: { replaceState() {} },
    document: {
      querySelector(selector: string) {
        const element = elements.get(selector);
        assert.ok(element, "missing page element " + selector);
        return element;
      },
      createElement() {
        return new Element();
      },
    },
    addEventListener() {},
    setInterval() {
      return 1;
    },
    clearInterval() {},
    setTimeout() {},
    confirm() {
      return true;
    },
    fetch: async (_url: unknown, options: any) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      return {
        ok: true,
        json: async () => ({
          ticket: "ticket",
          session_id: body.action === "acquire" ? "lease-id" : undefined,
        }),
      };
    },
  };
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0].action, "view");
  elements.get("#text")!.value = "中文输入";
  await elements.get("#sendText")!.onclick!();
  assert.equal(
    calls.some((c) => c.action === "text"),
    false,
  );
  await elements.get("#control")!.onclick!();
  await elements.get("#sendText")!.onclick!();
  assert.deepEqual(calls.at(-1), {
    action: "text",
    session_id: "lease-id",
    text: "中文输入",
  });
  assert.equal(elements.get("#text")!.value, "");
});
