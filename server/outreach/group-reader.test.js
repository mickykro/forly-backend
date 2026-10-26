const test = require("node:test"),
  assert = require("node:assert/strict");
const { readGroups, canonicalPost } = require("./group-reader");
test("post links are canonical and constrained to the current group", () => {
  assert.equal(
    canonicalPost("https://www.facebook.com/groups/123/posts/456/?x=1", "123"),
    "https://www.facebook.com/groups/123/posts/456/",
  );
  for (const url of [
    "https://evil.example/groups/123/posts/456/",
    "https://www.facebook.com/groups/999/posts/456/",
    "https://www.facebook.com/profile.php?id=1",
  ])
    assert.equal(canonicalPost(url, "123"), null);
});
test("one owned session discovers memberships, filters real estate and enforces feed caps", async () => {
  let sessions = 0,
    options,
    owner;
  const nav = [],
    wheels = [];
  const page = {
    goto: async (url) => nav.push(url),
    url: () => nav.at(-1),
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    mouse: { wheel: async (...args) => wheels.push(args) },
    evaluate: async () =>
      Array.from({ length: 30 }, (_, i) => ({
        source_post_url: `https://www.facebook.com/groups/123/posts/${i + 1}/`,
        description: "A property description",
        images: ["https://scontent.xx.fbcdn.net/a.jpg"],
      })),
  };
  const result = await readGroups(
    {
      phone: "0501234567",
      conn: { ok: true },
      profileName: "owner",
      maxGroups: 1,
      maxPosts: 2,
      jobId: "scan",
    },
    {
      withPage: async (opts, fn, who) => {
        sessions++;
        options = opts;
        owner = who;
        return fn(page);
      },
      syncMembership: async () => [
        { url: "https://www.facebook.com/groups/123", name: "Apartments rent" },
        { url: "https://www.facebook.com/groups/456", name: "Cats" },
      ],
      readSignal: async () => "ok",
    },
  );
  assert.equal(sessions, 1);
  assert.equal(owner.phone, "0501234567");
  assert.equal(options.profile.name, "owner");
  assert.equal(result.posts.length, 2);
  assert.equal(nav.length, 1);
  assert.ok(wheels.length <= 3);
});
test("selected URLs cannot introduce groups outside joined real estate discovery", async () => {
  const result = await readGroups(
    {
      phone: "owner",
      profileName: "profile",
      conn: {},
      groupUrls: ["https://www.facebook.com/groups/999"],
    },
    {
      withPage: async (opts, fn) => fn({}),
      syncMembership: async () => [
        { url: "https://www.facebook.com/groups/123", name: "Apartments" },
      ],
      readSignal: async () => "ok",
    },
  );
  assert.equal(result.posts.length, 0);
  assert.ok(result.warnings.includes("selected_group_not_eligible"));
});
test("login/checkpoint halt without scraping", async () => {
  let scraped = false;
  await assert.rejects(
    () =>
      readGroups(
        { phone: "owner", profileName: "profile", conn: {} },
        {
          withPage: async (opts, fn) =>
            fn({
              goto: async () => {},
              waitForLoadState: async () => {},
              url: () => "https://www.facebook.com/checkpoint/",
              evaluate: async () => (scraped = true),
            }),
          syncMembership: async () => [
            { url: "https://www.facebook.com/groups/123", name: "Apartments" },
          ],
          readSignal: async () => "checkpoint",
        },
      ),
    (e) => e.code === "group_scan_checkpoint",
  );
  assert.equal(scraped, false);
});
test("DOM extractor reads only own post body and full size attached photos", () => {
  const { readArticles } = require("./group-reader");
  const prior = global.document;
  const article = { parentElement: { closest: () => null } };
  const node = (fields = {}, comment = false) => ({
    ...fields,
    closest: (selector) =>
      selector === '[role="article"]' ? article : comment ? {} : null,
  });
  const own = node({
      href: "https://www.facebook.com/groups/123/posts/789/?tracking=1",
    }),
    cross = node({ href: "https://www.facebook.com/groups/999/posts/888/" }),
    message = node({ innerText: "Property facts only" }),
    photo = node({
      src: "https://scontent.xx.fbcdn.net/property.jpg",
      naturalWidth: 1200,
      naturalHeight: 800,
    }),
    avatar = node({
      src: "https://scontent.xx.fbcdn.net/avatar.jpg",
      naturalWidth: 1200,
      naturalHeight: 1200,
      getBoundingClientRect: () => ({ width: 40, height: 40 }),
    }),
    comment = node(
      {
        src: "https://scontent.xx.fbcdn.net/comment.jpg",
        naturalWidth: 1200,
        naturalHeight: 800,
      },
      true,
    );
  article.querySelectorAll = (selector) =>
    selector === "a[href]"
      ? [cross, own]
      : selector === "img"
        ? [avatar, comment, photo]
        : [message];
  const nested = {
    parentElement: { closest: () => article },
    querySelectorAll: () =>
      assert.fail("must never read nested comment article"),
  };
  try {
    global.document = { querySelectorAll: () => [article, nested] };
    const rows = readArticles({ groupSlug: "123", limit: 20 });
    assert.deepEqual(rows, [
      {
        source_post_url: "https://www.facebook.com/groups/123/posts/789/",
        description: "Property facts only",
        images: ["https://scontent.xx.fbcdn.net/property.jpg"],
      },
    ]);
    article.querySelectorAll = (selector) =>
      selector === "a[href]" ? [own] : [];
    assert.deepEqual(
      readArticles({ groupSlug: "123", limit: 20 }),
      [],
      "no broad article text fallback",
    );
  } finally {
    if (prior === undefined) delete global.document;
    else global.document = prior;
  }
});
test("rotation reaches later joined real estate groups and caps unique posts across scrolls", async () => {
  const nav = [],
    wheels = [];
  const page = {
    goto: async (url) => nav.push(url),
    url: () => nav.at(-1),
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    mouse: { wheel: async () => wheels.push(1) },
    evaluate: async () => [
      {
        source_post_url: "https://www.facebook.com/groups/456/posts/1/",
        description: "property",
        images: [],
      },
      {
        source_post_url: "https://www.facebook.com/groups/999/posts/2/",
        description: "crossgroup must drop",
        images: [],
      },
    ],
  };
  const result = await readGroups(
    {
      phone: "owner",
      conn: {},
      profileName: "profile",
      groupOffset: 1,
      maxGroups: 1,
      maxPosts: 60,
    },
    {
      withPage: async (opts, fn) => fn(page),
      syncMembership: async () => [
        { url: "https://www.facebook.com/groups/123", name: "Apartments" },
        { url: "https://www.facebook.com/groups/456", name: "Homes for rent" },
      ],
      readSignal: async () => "ok",
    },
  );
  assert.equal(result.groups_available, 2);
  assert.equal(result.next_group_offset, 0);
  assert.equal(result.posts.length, 1);
  assert.equal(result.groups[0].url, "https://www.facebook.com/groups/456/");
  assert.equal(wheels.length, 3);
});
test("vanity and numeric canonical group aliases keep actual post URL and dedupe same post", async () => {
  const urls = [];
  const page = {
    goto: async (url) => urls.push(url),
    url: () => urls.at(-1),
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    mouse: { wheel: async () => {} },
    $eval: async (selector) => {
      if (selector.startsWith("link"))
        return "https://www.facebook.com/groups/123/";
      throw Error("missing");
    },
    evaluate: async (_fn, args) => {
      assert.deepEqual(
        new Set(args.groupSlugs),
        new Set(["homes.haifa", "123"]),
      );
      return [
        {
          source_post_url: "https://www.facebook.com/groups/123/posts/987/",
          description: "Property facts",
          images: [],
        },
        {
          source_post_url:
            "https://www.facebook.com/groups/homes.haifa/posts/987/",
          description: "Same post via vanity",
          images: [],
        },
        {
          source_post_url: "https://www.facebook.com/groups/999/posts/111/",
          description: "Unrelated source",
          images: [],
        },
      ];
    },
  };
  const result = await readGroups(
    { phone: "operator", conn: {}, profileName: "owned" },
    {
      withPage: async (_opts, fn, owner) => {
        assert.equal(owner.phone, "operator");
        assert.equal(owner.platform, "facebook");
        return fn(page);
      },
      syncMembership: async () => [
        {
          url: "https://www.facebook.com/groups/homes.haifa/",
          name: "Apartments Haifa",
        },
      ],
      readSignal: async () => "ok",
    },
  );
  assert.equal(result.posts.length, 1);
  assert.equal(
    result.posts[0].source_post_url,
    "https://www.facebook.com/groups/123/posts/987/",
  );
});
test("reader deadline closes page and unwinds owned session even if membership read stalls", async () => {
  let closed = 0,
    cleaned = 0;
  await assert.rejects(
    readGroups(
      { phone: "operator", conn: {}, profileName: "owned" },
      {
        deadlineMs: 20,
        withPage: async (opts, fn, owner) => {
          assert.equal(opts.duration, 300);
          assert.equal(owner.phone, "operator");
          try {
            return await fn({ close: async () => closed++ });
          } finally {
            cleaned++;
          }
        },
        syncMembership: async () => new Promise(() => {}),
        readSignal: async () => "ok",
      },
    ),
    (error) => error.code === "group_scan_deadline",
  );
  assert.equal(closed, 1);
  assert.equal(cleaned, 1);
});
test("login form at unchanged joined-groups URL fails closed despite generic signal reporting ok", async () => {
  let membership = 0;
  let afterMembership = false;
  const page = {
    url: () => "https://www.facebook.com/groups/joins/",
    $eval: async (selector, fn) => {
      assert.equal(selector, "body");
      return afterMembership
        ? fn({
            querySelector: (query) =>
              query.includes("email") || query.includes("pass") ? {} : null,
          })
        : false;
    },
  };
  await assert.rejects(
    readGroups(
      { phone: "operator", conn: {}, profileName: "owned" },
      {
        withPage: async (_opts, fn) => fn(page),
        syncMembership: async () => {
          membership++;
          afterMembership = true;
          return [];
        },
        readSignal: async () => "ok",
      },
    ),
    (error) => error.code === "group_scan_login_required",
  );
  assert.equal(membership, 1);
});
test("login DOM gate uses controls rather than text and gates before membership too", async () => {
  const { loginFormDetected } = require("./group-reader");
  assert.equal(loginFormDetected({ querySelector: () => null }), false);
  assert.equal(
    loginFormDetected({
      querySelector: (query) =>
        query === 'input[name="email"]' ||
        query === 'input[name="pass"],input[type="password"]'
          ? {}
          : null,
    }),
    true,
  );
  let invoked = false;
  await assert.rejects(
    readGroups(
      { phone: "operator", conn: {}, profileName: "owned" },
      {
        withPage: async (_opts, fn) =>
          fn({
            url: () => "https://www.facebook.com/groups/joins/",
            $eval: async () => true,
          }),
        syncMembership: async () => {
          invoked = true;
          return [];
        },
      },
    ),
    (error) => error.code === "group_scan_login_required",
  );
  assert.equal(invoked, false);
});
