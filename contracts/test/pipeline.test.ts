// Every amount and account in these tests is invented. None is a reading of any real campaign.
//
// The whole pipeline in one test, with nothing built by hand in between: the contract's real
// receipts, as the node's JSON-RPC gives them, go through the real streams/filter.js (run as
// plain source with a Key-Value Store), each thing the filter returns is signed and POSTed to
// the keeper's real HTTP server, and the keeper's real sender calls the contract. The only
// stand-in is for QuickNode itself (scripts/lib/localStream.ts): the thing that calls the filter
// once per block. The payload shape is QuickNode's documented one, not yet one recorded from Arc.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { Outcome, setup, USD } from "./helpers.ts";
import { makeSender } from "../../services/keeper/src/chain.ts";
import { createKeeper, type Sender } from "../../services/keeper/src/keeper.ts";
import { createServer } from "../../services/keeper/src/server.ts";
import { memoryStore } from "../../services/keeper/src/store.ts";
import { loadFilter, signedHeaders, streamBlocks } from "../../scripts/lib/localStream.ts";

type W = Awaited<ReturnType<typeof setup>>;
type Json = Record<string, unknown>;

const SECRET = "pipeline-test-token-invented";
const filterSource = readFileSync(new URL("../../streams/filter.js", import.meta.url), "utf8");
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The contract, the filter, the keeper's server and its sender, wired as they are on Arc. */
async function rig(w: W, secretForPosts: string = SECRET) {
  let inFlight = 0;
  const calls: string[] = [];
  const direct = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
  const send: Sender = async (action) => {
    inFlight += 1;
    calls.push(action.kind === "payMany" ? `payMany:${action.id}` : action.kind === "paySide" ? `paySide:${action.id}:${action.side}` : `finalize:${action.id}`);
    try {
      return await direct(action);
    } finally {
      inFlight -= 1;
    }
  };
  const keeper = createKeeper({ boomerang: w.boomerang.address, store: memoryStore(), send });
  const server = createServer({ keeper, secret: SECRET });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/stream`;

  const filter = loadFilter(filterSource, w.boomerang.address);
  const request = (args: { method: string; params?: unknown[] }) => w.publicClient.request(args as never) as Promise<unknown>;
  const delivered: Json[] = [];
  const statuses: number[] = [];
  let next = 0n;

  // Wait until the keeper has nothing in the air: a POST is answered before its sends finish.
  async function quiet(): Promise<void> {
    for (let still = 0; still < 4; ) {
      await pause(5);
      still = inFlight === 0 ? still + 1 : 0;
    }
  }

  /** Feed the filter every block not yet seen, until the chain stops growing. */
  async function run(): Promise<void> {
    for (let round = 0; round < 60; round++) {
      const latest = await w.publicClient.getBlockNumber();
      if (next > latest) return;
      const out = await streamBlocks({
        request,
        filter,
        from: next,
        to: latest,
        post: async (body) => {
          const res = await fetch(url, { method: "POST", headers: signedHeaders(secretForPosts, body), body });
          statuses.push(res.status);
          await res.arrayBuffer();
          await quiet();
        },
      });
      delivered.push(...out);
      next = latest + 1n;
      await quiet();
    }
    assert.fail("the chain kept growing: the keeper did not come to rest");
  }

  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { keeper, filter, run, delivered, statuses, calls, close };
}

describe("contract -> filter -> signed webhook -> keeper -> contract", function () {
  it("pipeline.settles: a funded, a missed and a void campaign are settled with no hand anywhere, and the keeper's ledger equals the contract", async function () {
    const w = await setup();
    const r = await rig(w);
    try {
      // Funded by its backers.
      const funded = await w.open();
      await w.time.increaseTo(funded.t.opensAt);
      await w.pledge(funded.id, w.alice, 60n * USD, funded.t.opensAt + 10n);
      await w.pledge(funded.id, w.bob, 40n * USD, funded.t.opensAt + 20n);
      await r.run();
      assert.equal((await w.boomerang.read.stateOf([funded.id])).recipientPaid, true);
      assert.equal((await w.boomerang.read.stateOf([funded.id])).bonusReturned, true);

      // Void: the bonus pot is never locked. Nothing but the clock passing tells anyone.
      const empty = await w.open({}, { skipBonus: true });
      await r.run();
      assert.equal((await w.boomerang.read.stateOf([empty.id])).outcome, Outcome.Open);
      await w.time.increaseTo(empty.t.opensAt);
      await r.run();
      assert.equal((await w.boomerang.read.stateOf([empty.id])).outcome, Outcome.Void);
      assert.equal((await w.boomerang.read.stateOf([empty.id])).matchReturned, true);

      // Missed: two early backers, one late, short of the target.
      const missed = await w.open();
      await w.time.increaseTo(missed.t.opensAt);
      await w.pledge(missed.id, w.bob, 30n * USD, missed.t.opensAt + 10n);
      await w.pledge(missed.id, w.carol, 20n * USD, missed.t.opensAt + 20n);
      await w.pledge(missed.id, w.dave, 10n * USD, missed.t.earlyUntil + 5n);
      await r.run();
      assert.equal((await w.boomerang.read.stateOf([missed.id])).outcome, Outcome.Open);
      assert.ok(!r.calls.includes(`finalize:${missed.id}`), "nothing is finalized before its deadline");
      await w.time.increaseTo(missed.t.closesAt);
      await r.run();

      const s = await w.boomerang.read.stateOf([missed.id]);
      assert.equal(s.outcome, Outcome.Missed);
      assert.equal(s.matchReturned, true);
      assert.equal(s.bonusReturned, true);
      for (const who of [w.bob, w.carol, w.dave]) {
        assert.equal((await w.boomerang.read.backerOf([missed.id, who.account.address])).paid, true);
      }
      // Only rounding dust from the bonus split may be left owed.
      assert.ok((await w.boomerang.read.totalOwed()) < 3n, `left owed: ${await w.boomerang.read.totalOwed()}`);
      await w.assertCustody();

      // The keeper's ledger, built from nothing but the filter's deliveries, equals the contract.
      const h = r.keeper.health();
      assert.equal(h.missing, null);
      assert.equal(BigInt(h.lastSeq), await w.boomerang.read.eventCount());
      assert.equal(r.keeper.ledger.totalOwed, await w.boomerang.read.totalOwed());
      assert.equal(h.settled, true);
      assert.equal(h.failedSends, 0);
      assert.equal(h.kvError, null);
      for (const id of [funded.id, empty.id, missed.id]) {
        const c = r.keeper.ledger.campaigns.get(id)!;
        const chain = await w.boomerang.read.stateOf([id]);
        assert.equal(c.outcome, chain.outcome);
        assert.equal(c.pledged, chain.pledged);
        assert.equal(c.bonusPaid, chain.bonusPaid);
      }

      // Every delivery was accepted, and every one is something the filter chose to say.
      assert.ok(r.statuses.length > 0 && r.statuses.every((x) => x === 200), `statuses ${r.statuses}`);
      const opened = r.delivered.flatMap((d) => d.opened as string[]);
      assert.deepEqual([...opened].sort(), [funded.id, empty.id, missed.id].map(String).sort());
      assert.equal(new Set(opened).size, opened.length, "each opening is announced once");
      const due = new Set(r.delivered.flatMap((d) => d.due as string[]));
      assert.ok(due.has(String(missed.id)), "the missed campaign was announced as due");
      assert.ok(!due.has(String(funded.id)), "a campaign funded before its deadline is never due");

      // The filter's memory ends clean: nothing left open, all three recorded as final.
      assert.deepEqual(r.filter.kv.list("boomerang_open"), []);
      assert.deepEqual(r.filter.kv.list("boomerang_final"), [funded.id, empty.id, missed.id].map(String).sort());

      // No call was sent that the contract refused, and finalize went out once per campaign that needed it.
      assert.equal(r.calls.filter((c) => c === `finalize:${missed.id}`).length, 1);
      assert.equal(r.calls.filter((c) => c === `finalize:${empty.id}`).length, 1);
      assert.equal(r.calls.filter((c) => c === `finalize:${funded.id}`).length, 0);
    } finally {
      await r.close();
    }
  });

  it("pipeline.signature: the same deliveries signed with another token are all refused and nothing is settled", async function () {
    const w = await setup();
    const r = await rig(w, "not-the-stream-token");
    try {
      const missed = await w.open();
      await w.time.increaseTo(missed.t.opensAt);
      await w.pledge(missed.id, w.bob, 30n * USD, missed.t.opensAt + 10n);
      await w.time.increaseTo(missed.t.closesAt);
      await r.run();
      assert.ok(r.statuses.length > 0 && r.statuses.every((x) => x === 401), `statuses ${r.statuses}`);
      assert.equal(r.keeper.health().deliveries, 0);
      assert.equal(r.calls.length, 0);
      assert.equal((await w.boomerang.read.stateOf([missed.id])).outcome, Outcome.Open);
    } finally {
      await r.close();
    }
  });
});
