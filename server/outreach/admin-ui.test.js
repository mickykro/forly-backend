const test = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path");
test("admin delivery kit renders and copies only approved preview message and watermarked URL", async () => {
  const elements = {};
  function element(id) {
    return (
      elements[id] ||
      (elements[id] = {
        innerHTML: "",
        textContent: "",
        classList: {
          toggle() {},
          remove() {},
          contains() {
            return false;
          },
        },
        handlers: {},
        addEventListener(name, handler) {
          this.handlers[name] = handler;
        },
      })
    );
  }
  let copied;
  const message = "<script>reviewed copy</script>";
  const context = {
    document: { querySelector: element, querySelectorAll: () => [] },
    FLY: {
      esc: (value) =>
        String(value ?? "").replace(
          /[&<>"']/g,
          (c) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[c],
        ),
      toast() {},
      req: async (url) =>
        url.endsWith("/delivery-kit")
          ? {
              preview_url: "/d/opaque",
              demo: {
                video_url: "/api/outreach/assets/video?token=opaque",
                expires_at: "2030-01-01",
              },
              attempt: { message, copy_hash: "version" },
            }
          : { leads: [] },
    },
    location: { origin: "https://forly.example" },
    navigator: {
      clipboard: {
        writeText: async (value) => {
          copied = value;
        },
      },
    },
    crypto: { randomUUID: () => "id" },
    window: {},
    URL,
    clearTimeout,
    setTimeout,
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../../public-agent/admin-outreach.js"),
      "utf8",
    ),
    context,
  );
  element("#outreachDetail").handlers.click({
    target: {
      closest: (selector) =>
        selector === "[data-action]" ? { dataset: { action: "kit" } } : null,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(element("#outreachKit").innerHTML, /data-copy="preview"/);
  assert.match(element("#outreachKit").innerHTML, /data-copy="message"/);
  assert.match(element("#outreachKit").innerHTML, /data-copy="video"/);
  assert.ok(!element("#outreachKit").innerHTML.includes("<script>reviewed"));
  element("#outreachDetail").handlers.click({
    target: {
      closest: (selector) =>
        selector === "[data-copy]" ? { dataset: { copy: "video" } } : null,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    copied,
    "https://forly.example/api/outreach/assets/video?token=opaque",
  );
});
