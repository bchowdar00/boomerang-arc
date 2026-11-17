// Every amount, address and time in these tests is invented. None is a reading of any real campaign.
// The filter runs here as it does at QuickNode: as plain source, with only `qnLib` provided.
// The block shape (entry.block, entry.receipts[].logs[]) follows QuickNode's documented
// block_with_receipts examples; it has not yet been checked against a recorded Arc payload.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

import { encodeAbiParameters, encodeEventTopics, getAbiItem, toEventSelector } from "viem";

const here = new URL(".", import.meta.url);
const source = readFileSync(new URL("filter.js", here), "utf8");
const abi = JSON.parse(
  readFileSync(new URL("../contracts/artifacts/contracts/Boomerang.sol/Boomerang.json", here), "utf8"),
).abi;

const BOOMERANG = "0x00000000000000000000000000000000b0031a9c";
const OTHER = "0x00000000000000000000000000000000000000aa";
const SPONSOR = "0x00000000000000000000000000000000000000b1";
const BACKER = "0x00000000000000000000000000000000000000c1";

/**
 * A fresh filter with an in-memory Key-Value Store. `failing` makes every store call throw.
 * `store.failReads` and `store.failWrites` can be switched during a test, `store.failWriteOf`
 * fails writes to one named list only, and `store.readError` is the message a failed read
 * carries; `missing` picks how a list that does not exist yet reads: as nothing, or as a
 * not-found error.
 */
function load({ failing = false, missing = "undefined" } = {}) {
  const lists = new Map();
  const calls = { reads: 0, writes: 0 };
  const store = { failReads: failing, failWrites: failing, failWriteOf: null, readError: "store unavailable" };
  const qnLib = {
    async qnGetList(name) {
      calls.reads++;
      if (store.failReads) throw new Error(store.readError);
      if (!lists.has(name) && missing === "error") throw new Error("list not found");
      return lists.has(name) ? [...lists.get(name)] : undefined;
    },
    async qnUpsertList(name, { add_items = [], remove_items = [] }) {
      calls.writes++;
      if (store.failWrites || store.failWriteOf === name) throw new Error("store unavailable");
      const set = lists.get(name) ?? new Set();
      for (const x of remove_items) set.delete(x);
      for (const x of add_items) set.add(x);
      lists.set(name, set);
    },
  };
  const context = vm.createContext({ qnLib, console });
  vm.runInContext(source.replace(/const BOOMERANG = "0x0{40}";/, `const BOOMERANG = "${BOOMERANG}";`), context);
  const main = vm.runInContext("main", context);
  const list = (name) => [...(lists.get(name) ?? [])].sort();
  return { main, list, calls, store };
}

let seq = 0n;
let logIndex = 0;
function log(eventName, args, address = BOOMERANG) {
  const item = getAbiItem({ abi, name: eventName });
  const topics = encodeEventTopics({ abi, eventName, args });
  const plain = item.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => args[i.name]));
  return { address, topics, data, logIndex: `0x${(logIndex++).toString(16)}`, transactionHash: `0x${"ab".repeat(32)}` };
}
const terms = (opensAt, closesAt) => ({
  recipient: OTHER,
  opensAt: BigInt(opensAt),
  earlyUntil: BigInt(opensAt + 50),
  closesAt: BigInt(closesAt),
  target: 100_000_000n,
  minPledge: 1_000_000n,
  matchAmount: 20_000_000n,
  bonusPool: 10_000_000n,
  rateBps: 500,
  linearWeight: false,
  bonusFromRecipient: false,
});
const created = (id, opensAt, closesAt, address) =>
  log("CampaignCreated", { seq: ++seq, id: BigInt(id), sponsor: SPONSOR, terms: terms(opensAt, closesAt) }, address);
const finalizedLog = (id) => log("Finalized", { seq: ++seq, id: BigInt(id), outcome: 2, bonusPaid: 0n });
const pledged = (id) =>
  log("Pledged", { seq: ++seq, id: BigInt(id), backer: BACKER, payer: BACKER, amount: 5_000_000n, weight: 1_000_000n });

/** One block as the block_with_receipts dataset delivers it. */
const block = (number, time, logs = []) => ({
  block: { number: `0x${number.toString(16)}`, timestamp: `0x${time.toString(16)}` },
  receipts: logs.length ? [{ transactionHash: `0x${"cd".repeat(32)}`, logs }] : [],
});
const run = (f, ...blocks) => f.main({ data: blocks, metadata: { network: "arc-testnet" } });

describe("the Stream filter", function () {
  it("its event topics are the contract's", function () {
    const inFile = [...source.matchAll(/"(0x[0-9a-f]{64})": "(\w+)"/g)].map((m) => [m[2], m[1]]).sort();
    const inAbi = abi.filter((x) => x.type === "event").map((e) => [e.name, toEventSelector(e)]).sort();
    assert.deepEqual(inFile, inAbi);
    assert.equal(inAbi.length, 9);
  });

  it("a block with nothing of Boomerang's is not delivered and writes nothing", async function () {
    const f = load();
    assert.equal(await run(f, block(101, 1_000)), null);
    assert.equal(await run(f, block(102, 1_001, [pledged(1)].map((l) => ({ ...l, address: OTHER })))), null);
    assert.equal(f.calls.writes, 0);
  });

  it("an empty or malformed delivery is not delivered either", async function () {
    const f = load();
    assert.equal(await f.main({ data: [] }), null);
    assert.equal(await f.main({}), null);
    assert.equal(await f.main({ data: [{}] }), null);
  });

  it("Boomerang's logs pass through untouched, with the block's number and time", async function () {
    const f = load();
    const l = pledged(7);
    const out = await run(f, block(200, 5_000, [l]));
    assert.equal(out.v, 1);
    assert.deepEqual([out.fromBlock, out.toBlock, out.time], [200, 200, 5_000]);
    assert.deepEqual(JSON.parse(JSON.stringify(out.logs)), [
      { address: l.address, topics: l.topics, data: l.data, blockNumber: "0xc8", blockTimestamp: "0x1388", transactionHash: l.transactionHash, logIndex: l.logIndex },
    ]);
    assert.deepEqual([...out.opened], []);
    assert.deepEqual([...out.due], []);
  });

  it("the contract's address is matched whatever its letter case", async function () {
    const f = load();
    const l = { ...pledged(7), address: BOOMERANG.toUpperCase().replace("0X", "0x") };
    assert.equal((await run(f, block(201, 5_001, [l]))).logs.length, 1);
  });

  it("a created campaign is remembered with its opening time and deadline", async function () {
    const f = load();
    const out = await run(f, block(300, 9_000, [created(3, 10_000, 20_000)]));
    assert.equal(out.logs.length, 1);
    assert.deepEqual(f.list("boomerang_open"), ["3:10000:20000"]);
    assert.deepEqual([...out.opened, ...out.due], []);
  });

  it("opening is announced once", async function () {
    const f = load();
    await run(f, block(300, 9_000, [created(3, 10_000, 20_000)]));
    assert.equal(await run(f, block(301, 9_999)), null);
    const out = await run(f, block(302, 10_000));
    assert.deepEqual([...out.opened], ["3"]);
    assert.deepEqual(f.list("boomerang_open"), ["3:0:20000"]);
    assert.equal(await run(f, block(303, 10_001)), null);
  });

  it("a campaign is due from its deadline: every block at first, then every 25th, until it is finalized", async function () {
    const f = load();
    await run(f, block(300, 9_000, [created(3, 10_000, 20_000)]));
    await run(f, block(302, 10_000));
    assert.equal(await run(f, block(400, 19_999)), null);
    assert.deepEqual([...(await run(f, block(401, 20_000))).due], ["3"]);
    assert.deepEqual([...(await run(f, block(402, 20_009))).due], ["3"]);
    assert.equal(await run(f, block(403, 20_010)), null); // past the eager window, not a 25th block
    assert.deepEqual([...(await run(f, block(425, 20_030))).due], ["3"]);
    assert.equal(await run(f, block(426, 20_031)), null);
    const out = await run(f, block(427, 20_032, [finalizedLog(3)]));
    assert.equal(out.logs.length, 1);
    assert.deepEqual([...out.due], []);
    assert.deepEqual(f.list("boomerang_open"), []);
    assert.deepEqual(f.list("boomerang_final"), ["3"]);
    assert.equal(await run(f, block(450, 20_100)), null);
  });

  it("a campaign that was never announced as opened is still due at its deadline", async function () {
    const f = load();
    await run(f, block(300, 9_000, [created(4, 10_000, 20_000)]));
    const out = await run(f, block(301, 20_001));
    assert.deepEqual([...out.due], ["4"]);
    assert.deepEqual([...out.opened], []);
  });

  it("several blocks in one delivery: created and finalized together leaves nothing behind", async function () {
    const f = load();
    const out = await run(f, block(500, 30_000, [created(5, 30_010, 30_020)]), block(501, 30_030, [finalizedLog(5)]));
    assert.deepEqual([out.fromBlock, out.toBlock, out.time], [500, 501, 30_030]);
    assert.equal(out.logs.length, 2);
    assert.deepEqual([...out.opened, ...out.due], []);
    assert.deepEqual(f.list("boomerang_open"), []);
    assert.deepEqual(f.list("boomerang_final"), ["5"]);
  });

  it("two campaigns are tracked apart", async function () {
    const f = load();
    await run(f, block(600, 40_000, [created(6, 40_010, 40_100), created(7, 40_010, 40_200)]));
    const opened = await run(f, block(601, 40_010));
    assert.deepEqual([...opened.opened].sort(), ["6", "7"]);
    assert.deepEqual([...(await run(f, block(602, 40_100))).due], ["6"]);
    await run(f, block(603, 40_101, [finalizedLog(6)]));
    assert.deepEqual([...(await run(f, block(604, 40_200))).due], ["7"]);
  });

  it("ledger.repeat at the source: a replayed block neither doubles a campaign nor revives a finalized one", async function () {
    const f = load();
    const creation = block(700, 50_000, [created(8, 50_010, 50_020)]);
    await run(f, creation);
    await run(f, creation);
    assert.deepEqual(f.list("boomerang_open"), ["8:50010:50020"]);
    await run(f, block(701, 50_021, [finalizedLog(8)]));
    const replay = await run(f, creation);
    assert.equal(replay.logs.length, 1); // the log is still passed on; the keeper's ledger drops the repeat by seq
    assert.deepEqual(f.list("boomerang_open"), []);
    assert.equal(await run(f, block(702, 50_100)), null);
  });

  it("if the store fails, the logs are still delivered and the failure is reported", async function () {
    const f = load({ failing: true });
    const out = await run(f, block(800, 60_000, [created(9, 60_010, 60_020)]));
    assert.equal(out.logs.length, 1);
    assert.equal(out.kvError, "store unavailable");
    const quiet = await run(f, block(801, 60_001));
    assert.equal(quiet.kvError, "store unavailable"); // a failing store is never silent
  });

  it("a store read that fails on the block that finalizes a campaign does not leave it due forever", async function () {
    const f = load();
    await run(f, block(901, 70_000, [created(10, 70_010, 70_020)]));
    f.store.failReads = true;
    const out = await run(f, block(902, 70_030, [finalizedLog(10)]));
    assert.equal(out.kvError, "store unavailable");
    assert.deepEqual(f.list("boomerang_final"), ["10"]); // the write still went through
    f.store.failReads = false;
    await run(f, block(903, 70_031)); // the next run sees it is final and clears the leftover
    assert.deepEqual(f.list("boomerang_open"), []);
    assert.equal(await run(f, block(925, 70_060)), null); // a 25th block, and nothing is due
  });

  it("a failed write of the open list on the block that finalizes a campaign does not leave it due forever", async function () {
    const f = load();
    await run(f, block(951, 71_000, [created(16, 71_010, 71_020)]));
    f.store.failWriteOf = "boomerang_open";
    const out = await run(f, block(952, 71_030, [finalizedLog(16)]));
    assert.equal(out.kvError, "store unavailable");
    assert.deepEqual(f.list("boomerang_final"), ["16"]); // written first, on its own
    assert.deepEqual(f.list("boomerang_open"), ["16:71010:71020"]); // the leftover
    f.store.failWriteOf = null;
    await run(f, block(953, 71_031));
    assert.deepEqual(f.list("boomerang_open"), []);
    assert.equal(await run(f, block(975, 71_060)), null); // a 25th block, and nothing is due
  });

  it("when no write reaches the final list, the campaign stays announced until one does", async function () {
    const f = load();
    await run(f, block(961, 72_000, [created(17, 72_010, 72_020)]));
    f.store.failWrites = true;
    await run(f, block(962, 72_030, [finalizedLog(17)]));
    f.store.failWrites = false;
    // The store never heard of the outcome: the filter keeps saying due on every 25th block.
    // The keeper plans from its own ledger, where the campaign is final, so it makes no call.
    assert.deepEqual([...(await run(f, block(975, 72_060))).due], ["17"]);
    // A replay of the finalizing block (or a restart of the Stream from before it) repairs it.
    await run(f, block(962, 72_030, [finalizedLog(17)]));
    assert.equal(await run(f, block(1000, 72_090)), null);
  });

  it("a campaign the store never recorded is still covered: the heartbeat gives the keeper the time", async function () {
    const f = load();
    f.store.failReads = true;
    f.store.failWrites = true;
    const lost = await run(f, block(1001, 80_000, [created(11, 80_010, 80_020)]));
    assert.equal(lost.logs.length, 1); // the keeper's own ledger learns the campaign from this log
    assert.equal(lost.kvError, "store unavailable");
    f.store.failReads = false;
    f.store.failWrites = false;
    assert.deepEqual(f.list("boomerang_open"), []);
    assert.equal(await run(f, block(1002, 80_021)), null); // the filter itself no longer knows it is due
    const beat = await run(f, block(1200, 80_300));
    assert.equal(beat.beat, true);
    assert.equal(beat.time, 80_300);
    assert.deepEqual([...beat.logs, ...beat.due, ...beat.opened], []);
    assert.equal(await run(f, block(1201, 80_301)), null);
  });

  it("the every-25th-block rule looks at every block in a delivery, not only the last", async function () {
    const f = load();
    await run(f, block(1300, 90_000, [created(12, 90_001, 90_002)]));
    // seven blocks, 1321 to 1327, long past the eager window: 1325 is inside
    const seven = [1321, 1322, 1323, 1324, 1325, 1326, 1327].map((n, i) => block(n, 90_100 + i));
    assert.deepEqual([...(await run(f, ...seven)).due], ["12"]);
    const none = [1328, 1329, 1330].map((n, i) => block(n, 90_110 + i));
    assert.equal(await run(f, ...none), null);
  });

  it("blocks out of order in one delivery still count: the lowest and highest numbers and the latest time are kept", async function () {
    const f = load();
    await run(f, block(1340, 91_000, [created(18, 91_001, 91_002)]));
    const out = await run(f, block(1352, 91_102), block(1349, 91_099), block(1350, 91_100));
    assert.deepEqual([...out.due], ["18"]); // 1350 is inside
    assert.deepEqual([out.fromBlock, out.toBlock, out.time], [1349, 1352, 91_102]);
  });

  it("a store error that is not about a missing list is never read as an empty list", async function () {
    for (const message of ["host not found", "No such host is known", "file does not exist", "status 5404", "404"]) {
      const f = load();
      f.store.failReads = true;
      f.store.readError = message;
      const out = await run(f, block(1601, 97_000));
      assert.equal(out && out.kvError, message, message);
    }
    for (const message of ["list not found", "List boomerang_open does not exist", "key not found: boomerang_final"]) {
      const f = load();
      f.store.failReads = true;
      f.store.readError = message;
      assert.equal(await run(f, block(1601, 97_000)), null, message);
    }
  });

  it("a payload whose parts are not arrays, or whose topics are not 32-byte hex, is skipped without a throw", async function () {
    const f = load();
    const good = pledged(19);
    for (const data of [{}, 7, "blocks", null, [7, "x", null]]) {
      assert.equal(await f.main({ data }), null);
    }
    assert.equal(await f.main({ data: [{ block: {}, receipts: {} }, { block: {}, receipts: [{ logs: 7 }] }] }), null);
    const odd = [
      { address: BOOMERANG, topics: [good.topics[0], good.topics[1], "0xnothex"], data: good.data },
      { address: BOOMERANG, topics: [good.topics[0], good.topics[1], "0x01"], data: good.data },
      { address: BOOMERANG, topics: [good.topics[0], 5, good.topics[2]], data: good.data },
      { address: BOOMERANG, topics: created(20, 1, 2).topics, data: "0x" + "zz".repeat(32 * 11) },
    ];
    const out = await run(f, block(1701, 98_000, [...odd, good]));
    assert.equal(out.logs.length, 1);
  });

  it("logs that are not shaped like Boomerang's are skipped, and main does not throw", async function () {
    const f = load();
    const good = pledged(13);
    const bad = [
      { address: BOOMERANG },
      { address: BOOMERANG, topics: [good.topics[0]], data: "0x" },
      { address: BOOMERANG, topics: good.topics, data: null },
      { address: BOOMERANG, topics: created(14, 1, 2).topics, data: "0x00" },
      { address: 7, topics: good.topics, data: good.data },
      null,
    ];
    const out = await run(f, block(1401, 95_000, [...bad, good]));
    assert.equal(out.logs.length, 1);
    assert.equal(await f.main({ data: [{ block: {}, receipts: [null, {}, { logs: null }] }] }), null);
  });

  it("a store whose lists do not exist yet reads as empty, not as a failure", async function () {
    const f = load({ missing: "error" });
    assert.equal(await run(f, block(1501, 96_000)), null);
    const out = await run(f, block(1502, 96_001, [created(15, 96_010, 96_020)]));
    assert.equal(out.kvError, undefined);
    assert.deepEqual(f.list("boomerang_open"), ["15:96010:96020"]);
  });

  it("a block whose number and time arrive as numbers is read as written, not as hex", async function () {
    const f = load();
    const out = await f.main({
      data: [{ block: { number: 1600, timestamp: 97_000 }, receipts: [{ logs: [created(16, 97_010, 97_020)] }] }],
    });
    assert.equal(out.fromBlock, 1600);
    assert.equal(out.toBlock, 1600);
    assert.equal(out.time, 97_000);
  });

  it("a digits-only block number is read as decimal, not hex", async function () {
    // "300" is block 300 (decimal), a heartbeat block; read as hex it would be 0x300 = 768, no beat.
    const f = load();
    const out = await f.main({ data: [{ block: { number: "300", timestamp: "90000" }, receipts: [] }] });
    assert.deepEqual([out.fromBlock, out.toBlock, out.time], [300, 300, 90_000]);
    assert.equal(out.beat, true);

    // "0x12c" is the same block 300, in hex this time.
    const g = load();
    const hex = await g.main({ data: [{ block: { number: "0x12c", timestamp: "90000" }, receipts: [] }] });
    assert.deepEqual([hex.fromBlock, hex.toBlock], [300, 300]);
    assert.equal(hex.beat, true);

    // Strings that are neither decimal nor 0x-hex, and non-strings, are not quantities: the block
    // bounds stay null. A Boomerang log in the block is still delivered, and main never throws.
    for (const bad of ["12c", "0x", "", "-1", null, {}]) {
      const h = load();
      const out = await h.main({ data: [{ block: { number: bad, timestamp: "90000" }, receipts: [{ logs: [pledged(1)] }] }] });
      assert.equal(out.logs.length, 1, `log still delivered for ${JSON.stringify(bad)}`);
      assert.equal(out.fromBlock, null, `no fromBlock from ${JSON.stringify(bad)}`);
      assert.equal(out.toBlock, null, `no toBlock from ${JSON.stringify(bad)}`);
    }
  });

  it("an upper-case first topic is still matched", async function () {
    const f = load();
    const good = pledged(5);
    const upper = { ...good, topics: [good.topics[0].slice(0, 2) + good.topics[0].slice(2).toUpperCase(), good.topics[1], good.topics[2]] };
    const out = await run(f, block(400, 50_000, [upper]));
    assert.equal(out.logs.length, 1);
  });

  it("a first topic that names a built-in property is not taken for an event", async function () {
    const f = load();
    const good = pledged(17);
    const odd = ["constructor", "toString", "__proto__"].map((name) => ({ ...good, topics: [name, good.topics[1], good.topics[2]] }));
    const out = await run(f, block(1701, 98_000, [...odd, good]));
    assert.equal(out.logs.length, 1);
  });

  it("the source keeps to the sandbox's rules", function () {
    assert.ok(!/\b(require|import|eval|fetch|process)\b\s*\(/.test(source.replace(/\/\/.*$/gm, "")));
    assert.match(source, /async function main\(stream\)/);
  });
});
