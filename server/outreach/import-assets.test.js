const assert = require("assert");
const { EventEmitter } = require("events");
const { downloadImage, createPrepareAssets } = require("./import-assets");
(async () => {
  for (const url of [
    "http://127.0.0.1/a",
    "http://[::1]/a",
    "file:///x",
    "https://user:pass@example.com/a",
  ])
    await assert.rejects(() => downloadImage(url));
  await assert.rejects(
    () =>
      downloadImage("https://media.example/a", {
        lookup: async () => [{ address: "192.168.1.1", family: 4 }],
      }),
    /blocked_private/,
  );
  const png = Buffer.from("89504e470d0a1a0a0000", "hex");
  let pinned;
  const request = (url, options, callback) => {
    options.lookup(url.hostname, {}, (e, address) => (pinned = address));
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      callback(res);
      res.emit("data", png);
      res.emit("end");
    };
    return req;
  };
  const redirectRequest = (url, options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 302;
      res.headers = { location: "http://127.0.0.1/private" };
      res.resume = () => {};
      callback(res);
    };
    return req;
  };
  await assert.rejects(
    () =>
      downloadImage("https://media.example/a", {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        request: redirectRequest,
      }),
    /blocked_private/,
  );
  const image = await downloadImage("https://media.example/a", {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request,
  });
  assert.equal(pinned, "93.184.216.34");
  assert.equal(image.content_type, "image/png");
  let rows;
  const prepare = createPrepareAssets({
    download: async () => image,
    assets: {
      registerRenditions: async (input) => {
        rows = input.renditions;
        return [
          { id: "source", rendition: "source_private" },
          { id: "web", rendition: "website_asset" },
        ];
      },
    },
  });
  assert.deepEqual(
    await prepare("demo", { images: ["https://media.example/a"] }),
    ["web"],
  );
  assert.deepEqual(
    rows.map((r) => r.rendition),
    ["source_private", "website_asset"],
  );
  console.log("outreach private import tests passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
require("node:test")(
  "source import rejects hexadecimal IPv4 mapped loopback before opening a socket",
  async () => {
    await assert.rejects(
      downloadImage("http://[::ffff:7f00:1]/property.jpg"),
      /blocked_private_address/,
    );
  },
);
