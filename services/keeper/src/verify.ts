// Is this webhook delivery really from our QuickNode Stream?
//
// QuickNode signs each delivery with the Stream's security token: HMAC-SHA256, in hex, over
// nonce + timestamp + body, where the body is the JSON text before any compression. The three
// pieces arrive in the X-QN-Nonce, X-QN-Timestamp and X-QN-Signature headers.
// (QuickNode's guide "Validating Incoming Streams Webhook Messages", read 2026-11-15.)
import { createHmac, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";

/**
 * The delivery's JSON text. A gzip-encoded body is decompressed first, as the signature covers
 * the plain text. A body labelled gzip that is not (some servers decompress before handing it
 * over and leave the header) is read as it is; the signature check then decides. A body that
 * would unpack to more than `maxBytes` reads as empty. Never throws.
 */
export function bodyText(raw: Uint8Array, contentEncoding: string | undefined, maxBytes: number = 64 * 1024 * 1024): string {
  const labelled = (contentEncoding ?? "").toLowerCase().includes("gzip");
  const isGzip = labelled && raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  if (isGzip) {
    try {
      // The size is capped: this runs before the signature is checked, so anyone can send it.
      return gunzipSync(raw, { maxOutputLength: maxBytes }).toString("utf8");
    } catch {
      return "";
    }
  }
  return Buffer.from(raw).toString("utf8");
}

/** True only when `given` is the HMAC of nonce + timestamp + body under `secret`. Never throws. */
export function verifySignature(
  secret: string,
  nonce: string | undefined,
  timestamp: string | undefined,
  body: string,
  given: string | undefined,
): boolean {
  if (!secret || !nonce || !timestamp || !given) return false;
  if (!/^[0-9a-fA-F]{64}$/.test(given)) return false;
  const expected = createHmac("sha256", Buffer.from(secret)).update(nonce + timestamp + body).digest();
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
}
