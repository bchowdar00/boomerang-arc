// Every amount and account in these tests is invented. None is a reading of any real campaign.
//
// The app's one-block read (web/src/app/world.ts) over the real contract.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setup, USD } from "./helpers.ts";
import { readWorld } from "../../web/src/app/world.ts";
import type { KeeperAnswer } from "../../web/src/data/ask.ts";
import { readHealth } from "../../web/src/data/health.ts";
import type { LedgerView } from "../../web/src/data/keeper.ts";
import { proofPage } from "../../web/src/views/proof.ts";

const noKeeper = async (): Promise<KeeperAnswer> => ({ up: false, why: "none" });
const ZERO = "0x0000000000000000000000000000000000000000";

describe("the app's one-block read", function () {
  it("world.oneBlock: every figure is read at the one block the page names", async function () {
    const w = await setup();
    const a = await w.open();
    await w.time.increaseTo(a.t.opensAt);
    await w.pledge(a.id, w.alice, 60n * USD, a.t.opensAt + 10n);
    const b = await w.open();
    await w.time.increaseTo(b.t.opensAt);
    await w.pledge(b.id, w.bob, 30n * USD, b.t.opensAt + 10n);

    // Record the block each read asks for.
    const asked: (bigint | undefined)[] = [];
    const watching = new Proxy(w.publicClient, {
      get(target, prop, receiver) {
        if (prop !== "readContract") return Reflect.get(target, prop, receiver);
        return (args: { blockNumber?: bigint }) => {
          asked.push(args.blockNumber);
          return (target.readContract as (a: unknown) => Promise<unknown>)(args);
        };
      },
    });
    const where = { boomerang: w.boomerang.address, usdc: w.usdc.address };
    const bob = w.bob.account.address;
    const world = await readWorld({ client: watching as typeof w.publicClient, where, account: bob, keeper: noKeeper });

    assert.ok(asked.length >= 12, `${asked.length} reads`);
    assert.ok(asked.every((n) => n === world.block), "every read names the same block");
    const block = await w.publicClient.getBlock({ blockNumber: world.block });
    assert.equal(world.now, block.timestamp);

    // The figures are the contract's.
    assert.equal(world.count, 2n);
    assert.deepEqual(world.campaigns.map((c) => c.id), [b.id, a.id]);
    for (const c of world.campaigns) assert.deepEqual(c.state, await w.boomerang.read.stateOf([c.id]));
    assert.equal(world.custody.block, world.block);
    assert.equal(world.custody.held, await w.balance({ address: w.boomerang.address }));
    assert.equal(world.custody.owed, await w.boomerang.read.totalOwed());
    assert.equal(world.custody.ok, true);
    assert.deepEqual(world.mine.map((m) => m.campaign.id), [b.id]);
    assert.equal(world.balance, await w.balance({ address: bob }));
    assert.equal(world.allowance, 0n);
    assert.deepEqual(world.keeper, { up: false, why: "none" });
  });

  it("world.then: a read made before a pledge stays what it was; the next read is of a later block and has the pledge", async function () {
    const w = await setup();
    const a = await w.open();
    await w.time.increaseTo(a.t.opensAt);
    const where = { boomerang: w.boomerang.address, usdc: w.usdc.address };
    const before = await readWorld({ client: w.publicClient, where, account: null, keeper: noKeeper });
    assert.equal(before.campaigns[0].state.pledged, 0n);
    assert.deepEqual([before.account, before.mine, before.balance, before.allowance], [null, [], null, null]);

    await w.pledge(a.id, w.alice, 60n * USD, a.t.opensAt + 10n);
    const after = await readWorld({ client: w.publicClient, where, account: null, keeper: noKeeper });
    assert.ok(after.block > before.block);
    assert.equal(after.campaigns[0].state.pledged, 60n * USD);
    assert.equal(before.campaigns[0].state.pledged, 0n);
    assert.equal(after.custody.owed - before.custody.owed, 60n * USD);
  });

  it("world.backers: the contract's own backer records are read at the one block, and a ledger with one wrong record reads differs", async function () {
    const w = await setup();
    const a = await w.open();
    await w.time.increaseTo(a.t.opensAt);
    await w.pledge(a.id, w.alice, 60n * USD, a.t.opensAt + 10n);
    const where = { boomerang: w.boomerang.address, usdc: w.usdc.address };
    const alice = w.alice.account.address;

    // A ledger that matches the contract, then one backer field (the pledged amount) made wrong.
    const terms = await w.boomerang.read.termsOf([a.id]);
    const state = await w.boomerang.read.stateOf([a.id]);
    const chainBacker = await w.boomerang.read.backerOf([a.id, alice]);
    const ledger: LedgerView = {
      lastSeq: await w.boomerang.read.eventCount(),
      totalOwed: await w.boomerang.read.totalOwed(),
      missing: null,
      feed: [],
      campaigns: [
        {
          id: a.id, sponsor: state.sponsor, terms, matchIn: state.matchIn, bonusIn: state.bonusIn, outcome: state.outcome,
          pledged: state.pledged, pledgedEarly: state.pledgedEarly, earlyUnknown: 0n, weighted: state.weighted,
          bonusPaid: state.bonusPaid, expectedBonusPaid: null, recipientPaid: state.recipientPaid, matchReturned: state.matchReturned,
          bonusReturned: state.bonusReturned, payFailures: 0,
          backers: [{ address: alice, principal: chainBacker.principal + 1n, weighted: chainBacker.weighted, payTo: chainBacker.payTo.toLowerCase() === ZERO ? null : chainBacker.payTo, paid: chainBacker.paid, paidPrincipal: 0n, paidBonus: 0n }],
        },
      ],
    };
    const health = readHealth({
      lastSeq: ledger.lastSeq.toString(), missing: null, pending: 0, repeats: 0, lastBlock: 0, lastTime: "0", lastDeliveryAt: null, lastBeatBlock: null,
      kvError: null, deliveries: 0, sent: 0, failedSends: 0, rejected: 0, gaveUp: [], lastErrors: [], settled: true, desk: null,
    });

    const world = await readWorld({ client: w.publicClient, where, account: alice, keeper: async (): Promise<KeeperAnswer> => ({ up: true, ledger, health }) });
    // The contract's own record was read for the one ledger backer, at the page's block.
    assert.equal(world.backerTotal, 1);
    assert.equal(world.backerChecks?.length, 1);
    assert.equal(world.backerChecks![0].chain.principal, chainBacker.principal);

    const page = proofPage({
      custody: world.custody, campaigns: world.campaigns, count: world.count,
      ledger, health, backerChecks: world.backerChecks, backerTotal: world.backerTotal,
      where: { ...where, router: w.boomerang.address },
    });
    assert.equal(page.second.state, "differs");
    assert.ok(
      page.second.differences.some((d) => d.includes("backer") && d.includes("pledged:")),
      page.second.differences.join(" | "),
    );
  });

  it("world.keeper: the keeper is asked once, its answer is passed through, and it changes no figure", async function () {
    const w = await setup();
    await w.open();
    const where = { boomerang: w.boomerang.address, usdc: w.usdc.address };
    let asks = 0;
    const down = await readWorld({
      client: w.publicClient,
      where,
      account: null,
      keeper: async () => {
        asks += 1;
        return { up: false, why: "unreachable" };
      },
    });
    assert.equal(asks, 1);
    assert.deepEqual(down.keeper, { up: false, why: "unreachable" });
    const none = await readWorld({ client: w.publicClient, where, account: null, keeper: noKeeper });
    assert.deepEqual(down.campaigns, none.campaigns);
    assert.deepEqual({ ...down.custody, block: 0n, time: 0n }, { ...none.custody, block: 0n, time: 0n });
  });
});
