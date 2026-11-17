// Every secret and payload in these tests is invented.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import { bodyText, verifySignature } from "../src/verify.ts";

const secret = "test-token-not-a-real-one";
const nonce = "5f3c9a";
const timestamp = "1794700000";
const body = JSON.stringify({ v: 1, logs: [], due: ["3"] });
const sign = (s: string, n: string, t: string, b: string) => createHmac("sha256", Buffer.from(s)).update(n + t + b).digest("hex");

describe("keeper: the Stream's signature", function () {
  it("accepts a delivery signed with the Stream's token", function () {
    assert.equal(verifySignature(secret, nonce, timestamp, body, sign(secret, nonce, timestamp, body)), true);
  });

  it("refuses a changed body, nonce or timestamp, and another token", function () {
    const good = sign(secret, nonce, timestamp, body);
    assert.equal(verifySignature(secret, nonce, timestamp, body + " ", good), false);
    assert.equal(verifySignature(secret, nonce + "0", timestamp, body, good), false);
    assert.equal(verifySignature(secret, nonce, "1794700001", body, good), false);
    assert.equal(verifySignature(secret, nonce, timestamp, body, sign("another-token", nonce, timestamp, body)), false);
  });

  it("refuses a missing or malformed header without throwing", function () {
    const good = sign(secret, nonce, timestamp, body);
    assert.equal(verifySignature(secret, undefined, timestamp, body, good), false);
    assert.equal(verifySignature(secret, nonce, undefined, body, good), false);
    assert.equal(verifySignature(secret, nonce, timestamp, body, undefined), false);
    assert.equal(verifySignature(secret, nonce, timestamp, body, "zz"), false);
    assert.equal(verifySignature(secret, nonce, timestamp, body, good.slice(2)), false);
    assert.equal(verifySignature("", nonce, timestamp, body, sign("", nonce, timestamp, body)), false);
  });

  it("checks a gzip delivery against its plain text", function () {
    const good = sign(secret, nonce, timestamp, body);
    const text = bodyText(gzipSync(body), "gzip");
    assert.equal(text, body);
    assert.equal(verifySignature(secret, nonce, timestamp, text, good), true);
    assert.equal(bodyText(Buffer.from(body), undefined), body);
  });

  it("reads a body labelled gzip that was already decompressed, and survives a corrupt one", function () {
    assert.equal(bodyText(Buffer.from(body), "gzip"), body);
    const corrupt = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from("not really gzip")]);
    assert.equal(bodyText(corrupt, "gzip"), "");
    assert.equal(verifySignature(secret, nonce, timestamp, bodyText(corrupt, "gzip"), sign(secret, nonce, timestamp, body)), false);
  });

  it("a gzip body that would unpack past the cap reads as empty, so it cannot fill the memory", function () {
    const big = gzipSync(Buffer.alloc(200_000, 0x20));
    assert.ok(big.length < 2_000);
    assert.equal(bodyText(big, "gzip", 100_000), "");
    assert.equal(bodyText(big, "gzip", 200_000).length, 200_000);
  });
});
