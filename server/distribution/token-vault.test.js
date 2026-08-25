/*
 * Unit tests for distribution/token-vault.js — tokens encrypted at rest.
 * Run: node server/distribution/token-vault.test.js
 */
const assert = require("assert");
const { PREFIX, keyFrom, encrypt, decrypt, sealConnection, openConnection } = require("./token-vault");

const key = keyFrom({ META_TOKEN_KEY: "a".repeat(64) });   // 32-byte hex
assert.ok(Buffer.isBuffer(key) && key.length === 32);
assert.equal(keyFrom({}), null, "no env ⇒ no key");
assert.equal(keyFrom({ META_TOKEN_KEY: "some passphrase" }).length, 32, "passphrase hashed to 32 bytes");

// ── roundtrip ──
const sealed = encrypt("EAAB-secret-token", key);
assert.ok(sealed.startsWith(PREFIX));
assert.ok(!sealed.includes("EAAB"), "ciphertext leaks nothing");
assert.equal(decrypt(sealed, key), "EAAB-secret-token");
assert.notEqual(encrypt("x", key), encrypt("x", key), "fresh IV every time");

// ── tamper ⇒ null, never garbage ──
assert.equal(decrypt(sealed.slice(0, -3) + "abc", key), null);

// ── migration semantics ──
assert.equal(decrypt("plain-old-token", key), "plain-old-token", "plaintext passes through");
assert.equal(decrypt(sealed, null), null, "encrypted without a key ⇒ unusable, not garbage");
assert.equal(encrypt("t", null), "t", "no key ⇒ stored as-is (feature off)");

// ── connection sealing: token fields + pending_pages, idempotent ──
const conn = { page_id: "P1", page_name: "Dana", user_token: "UT", page_token: "PT",
  pending_pages: [{ id: "A", name: "a", access_token: "AT" }] };
const s = sealConnection(conn, key);
assert.equal(s.page_name, "Dana", "non-secret fields untouched");
assert.ok(s.user_token.startsWith(PREFIX) && s.page_token.startsWith(PREFIX));
assert.ok(s.pending_pages[0].access_token.startsWith(PREFIX));
const s2 = sealConnection(s, key);
assert.equal(s2.page_token, s.page_token, "sealing twice does not double-encrypt");
const o = openConnection(s, key);
assert.equal(o.user_token, "UT");
assert.equal(o.page_token, "PT");
assert.equal(o.pending_pages[0].access_token, "AT");

console.log("token-vault.test.js OK");
