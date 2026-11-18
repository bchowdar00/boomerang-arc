// How the keeper stands against the chain at a read: down, prompt (by the Stream or the node), or
// behind. Every amount, address and block here is invented. Fixture style follows views.test.ts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KeeperAnswer } from "../src/data/ask.ts";
import { readHealth } from "../src/data/health.ts";
import type { LedgerView } from "../src/data/keeper.ts";
import { BEHIND_AFTER, paceOf } from "../src/data/pace.ts";

const wire = {
  lastSeq: "12", missing: null, pending: 0, repeats: 0, lastBlock: 400, lastTime: "1794000000", lastDeliveryAt: null, lastBeatBlock: null,
  kvError: null, deliveries: 0, sent: 0, failedSends: 0, rejected: 0, gaveUp: [], lastErrors: [], settled: false, desk: null,
};
// A keeper that is up, with health read from `wire` plus any overrides. The ledger is not read by paceOf.
const up = (over: Record<string, unknown> = {}): KeeperAnswer => ({ up: true, ledger: null as unknown as LedgerView, health: readHealth({ ...wire, ...over }) });
const NODE = { following: true, reads: 5, lastReadAt: null, readTo: null, faults: 0 };

describe("how the keeper stands against the chain", function () {
  it("pace.down: a keeper that did not answer", function () {
    assert.deepEqual(paceOf({ up: false, why: "unreachable" }, 500n), { state: "down" });
  });

  it("pace.prompt: an old keeper a little behind is prompt, by the Stream", function () {
    assert.deepEqual(paceOf(up(), 410n), { state: "prompt", by: "stream" }); // lag 10
  });

  it("pace.node: a keeper following the node itself is prompt, by the node", function () {
    assert.deepEqual(paceOf(up({ node: NODE }), 410n), { state: "prompt", by: "node" });
  });

  it("pace.behind: past the threshold, with the block it last heard and how far behind", function () {
    assert.deepEqual(paceOf(up(), 1301n), { state: "behind", heard: 400, blocks: 901 }); // lag 901
  });

  it("pace.nothing: a keeper that has heard no block at all is behind, however short the chain", function () {
    assert.deepEqual(paceOf(up({ lastBlock: 0 }), 40n), { state: "behind", heard: 0, blocks: 40 });
    assert.deepEqual(paceOf(up({ lastBlock: 0, node: { ...NODE, following: true } }), 40n), { state: "behind", heard: 0, blocks: 40 });
  });

  it("pace.edge: exactly the threshold is prompt, a keeper ahead is prompt, a node not following is by the Stream", function () {
    assert.equal(BEHIND_AFTER, 900);
    assert.deepEqual(paceOf(up(), 1300n), { state: "prompt", by: "stream" }); // lag exactly 900
    assert.deepEqual(paceOf(up(), 390n), { state: "prompt", by: "stream" }); // keeper ahead of the page's block
    assert.deepEqual(paceOf(up({ node: { ...NODE, following: false } }), 410n), { state: "prompt", by: "stream" });
  });
});
