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
test("group scan starts without supplied URLs and displays durable progress and warnings", async () => {
  const nodes = {};
  const element = (selector) =>
    nodes[selector] ||
    (nodes[selector] = {
      innerHTML: "",
      textContent: "",
      disabled: false,
      classList: {
        toggle() {},
        remove() {},
        contains() {
          return false;
        },
      },
      handlers: {},
      addEventListener(event, handler) {
        this.handlers[event] = handler;
      },
    });
  let submitted;
  const context = {
    document: { querySelector: element, querySelectorAll: () => [] },
    FLY: {
      esc: (value) => String(value ?? "").replace(/</g, "&lt;"),
      toast() {},
      req: async (url, options) => {
        if (url.endsWith("/scans")) {
          submitted = options.body;
          return {
            id: "scan",
            status: "queued",
            warnings: ["manual_review_required"],
          };
        }
        if (url.endsWith("/scans/scan"))
          return {
            id: "scan",
            status: "done",
            groups_visited: 2,
            posts_seen: 7,
            selected: 0,
            duplicates: 1,
            reasons: { missing_photos: 6 },
          };
        return { leads: [] };
      },
    },
    location: { origin: "https://forly.example" },
    navigator: {},
    crypto: { randomUUID: () => "request-id" },
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
  element("#outreachScanForm").handlers.submit({
    preventDefault() {},
    currentTarget: {
      campaign_id: { value: "outreach" },
      max_groups: { value: "3" },
      max_candidates: { value: "5" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submitted.max_groups, 3);
  assert.equal(submitted.max_candidates, 5);
  assert.equal(submitted.source_post_url, undefined);
  assert.equal(submitted.group_urls, undefined);
  assert.match(
    element("#outreachScanProgress").innerHTML,
    /manual_review_required/,
  );
  assert.match(element("#outreachScanProgress").innerHTML, /missing_photos/);
  assert.match(element("#outreachScanProgress").innerHTML, />0<\/p>/);
  assert.equal(element("#outreachScanStart").disabled, false);
});
test("opening Outreach restores the latest running scan and resumes polling", async () => {
  const nodes = {};
  const element = (selector) =>
    nodes[selector] ||
    (nodes[selector] = {
      innerHTML: "",
      textContent: "",
      disabled: false,
      classList: {
        toggle() {},
        remove() {},
        contains() {
          return false;
        },
      },
      handlers: {},
      addEventListener(event, handler) {
        this.handlers[event] = handler;
      },
    });
  let polled = 0;
  const context = {
    document: { querySelector: element, querySelectorAll: () => [] },
    FLY: {
      esc: (value) => String(value ?? ""),
      toast() {},
      req: async (url) => {
        if (url.endsWith("/scans"))
          return {
            scans: [
              {
                id: "existing-scan",
                status: "running",
                groups_visited: 1,
                posts_seen: 4,
              },
            ],
          };
        if (url.endsWith("/scans/existing-scan")) {
          polled++;
          return {
            id: "existing-scan",
            status: "done",
            groups_visited: 2,
            posts_seen: 9,
            selected: 3,
            duplicates: 0,
          };
        }
        return { leads: [] };
      },
    },
    location: { origin: "https://forly.example" },
    navigator: {},
    crypto: { randomUUID: () => "unused" },
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
  element("#tabOutreach").handlers.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polled, 1);
  assert.match(element("#outreachScanProgress").innerHTML, /done/);
  assert.match(element("#outreachScanProgress").innerHTML, />9<\/p>/);
  assert.equal(element("#outreachScanStart").disabled, false);
});
