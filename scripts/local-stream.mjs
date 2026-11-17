// A stand-in for the QuickNode Stream on a developer's machine. It follows a LOCAL node, runs
// streams/filter.js over each new block and posts what the filter returns to a local keeper,
// signed the way QuickNode signs. It refuses any node or keeper that is not on this machine:
// on Arc the Stream is QuickNode's, and nothing in production polls a chain.
//
//   BOOMERANG_ADDRESS=0x... STREAM_SECURITY_TOKEN=... node scripts/local-stream.mjs
//
// Optional: RPC_URL (default http://127.0.0.1:8545), KEEPER_URL (default
// http://127.0.0.1:8787/stream), FROM_BLOCK (default 0), EVERY_MS (default 500).
import { readFile } from "node:fs/promises";

import { loadFilter, signedHeaders, streamBlocks } from "./lib/localStream.ts";

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function localUrl(name, fallback) {
  const text = process.env[name] ?? fallback;
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(`${name} is not a URL`);
  }
  if (!LOCAL.has(url.hostname)) fail(`${name} must be on this machine (127.0.0.1 or localhost); the live Stream is QuickNode's, not this script`);
  return url.toString();
}

const rpcUrl = localUrl("RPC_URL", "http://127.0.0.1:8545");
const keeperUrl = localUrl("KEEPER_URL", "http://127.0.0.1:8787/stream");
const boomerang = process.env.BOOMERANG_ADDRESS;
if (!boomerang || !/^0x[0-9a-fA-F]{40}$/.test(boomerang)) fail("BOOMERANG_ADDRESS must be the local Boomerang's address");
const secret = process.env.STREAM_SECURITY_TOKEN;
if (!secret) fail("STREAM_SECURITY_TOKEN must be the same token the local keeper was started with");
const everyMs = Number(process.env.EVERY_MS ?? "500");
if (!Number.isInteger(everyMs) || everyMs < 50) fail("EVERY_MS must be a whole number of milliseconds, 50 or more");
let next = BigInt(process.env.FROM_BLOCK ?? "0");

let rpcId = 0;
async function request({ method, params = [] }) {
  // A redirect is refused: a local node that answered "go elsewhere" would take the requests off this machine.
  const res = await fetch(rpcUrl, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const answer = await res.json();
  if (answer.error) throw new Error(`${method}: ${answer.error.message}`);
  return answer.result;
}

const source = await readFile(new URL("../streams/filter.js", import.meta.url), "utf8");
const filter = loadFilter(source, boomerang);

async function post(body) {
  const res = await fetch(keeperUrl, { method: "POST", redirect: "error", headers: signedHeaders(secret, body), body });
  await res.arrayBuffer();
  if (res.status !== 200) throw new Error(`the keeper answered ${res.status}`);
}

console.log(`following ${rpcUrl} from block ${next}, posting to ${keeperUrl}`);
for (;;) {
  try {
    const latest = BigInt(await request({ method: "eth_blockNumber" }));
    if (latest >= next) {
      const delivered = await streamBlocks({ request, filter, from: next, to: latest, post });
      if (delivered.length > 0) console.log(`blocks ${next}..${latest}: ${delivered.length} delivered`);
      next = latest + 1n;
    }
  } catch (e) {
    // The block range is tried again on the next turn; the keeper drops what it has already seen.
    console.error(String(e && e.message ? e.message : e).split("\n")[0]);
  }
  await new Promise((r) => setTimeout(r, everyMs));
}
