// The Proof page: what a stranger can check, and what this app does not claim.
//
// Three things are set side by side. The contract's own figures, read at one block. A second
// ledger the keeper rebuilt from nothing but the contract's events as the Stream delivered them.
// And the Stream's own pulse. Only the first is the truth about the money; the other two are
// there to be compared with it, and the page says plainly when they are late, absent or wrong.
import type { Address } from "../../../packages/kit/src/index.ts";
import type { BackerCheck } from "../app/world.ts";
import type { HealthView } from "../data/health.ts";
import { backerDifferences, differences, short, standing, type LedgerView } from "../data/keeper.ts";
import type { CampaignView, Custody } from "../data/load.ts";
import { formatUsd } from "../data/money.ts";
import { utcStamp } from "../data/time.ts";
import type { Row } from "./campaign.ts";

export type ProofPage = {
  custody: { state: "ok" | "short" | "unread"; line: string; detail: string };
  second: {
    state: "agrees" | "differs" | "behind" | "ahead" | "down";
    line: string;
    /** Each disagreement, in words; empty unless the state is "differs". */
    differences: string[];
  };
  /** The Stream's pulse as the keeper reports it; null when the keeper cannot be reached. */
  stream: Row[] | null;
  /** Things the keeper itself reported going wrong, newest last, as plain text. */
  keeperErrors: string[];
  facts: Row[];
  /** How to check all of this without trusting this page. */
  yourself: { line: string; command: string };
  limits: string[];
};

export const LIMITS: readonly string[] = [
  "This runs on Arc Testnet with test USDC. No real money is involved and no real campaign has run on it.",
  "The names and descriptions of campaigns are this site's words. The contract holds only amounts, dates and addresses.",
  "The keeper and the Stream make payouts prompt; they are not needed for them. With both off, anyone can make the same calls and nothing is lost, only later.",
  "A pledge from another chain is refunded on Arc, to the backer's address there, not back across the bridge.",
  "A one-signature pledge is sent by the keeper, which pays its gas. The signature can move the backer's USDC only into the campaign and amount it names, once, within three minutes. When the keeper is down or refuses, the page offers the two-step pledge, which needs no keeper.",
  "The second ledger is only as good as the events delivered to the keeper. When it disagrees with the contract, the contract is right.",
  "Nothing here shows how people behave when a refund bonus is on offer. That has not been measured on this app.",
];

// "None", "Number 9", "Numbers 9 and 11", "Numbers 9, 11 and 12".
const numbers = (ids: readonly bigint[]): string =>
  ids.length === 0 ? "None" : ids.length === 1 ? `Number ${ids[0]}` : `Numbers ${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;

const KEEPER_DOWN = "The keeper cannot be reached, so the second ledger is not shown. The contract's figures above do not depend on it.";

export function proofPage(o: {
  /** Held, owed and the event count, read at one block; null if that read failed. */
  custody: Custody | null;
  /** The campaigns read from the contract at that same block: the newest `campaigns.length` of `count`. */
  campaigns: readonly CampaignView[];
  /** How many campaigns the contract has in all. When it is more than were read, only those read are compared. */
  count: bigint;
  ledger: LedgerView | null;
  health: HealthView | null;
  /** For up to 100 of the ledger's backer records (newest campaigns first), the contract's own record at this block; null when the keeper is down. */
  backerChecks: BackerCheck[] | null;
  /** How many backer records the ledger lists in all. */
  backerTotal: number;
  where: { boomerang: Address; usdc: Address; router: Address };
}): ProofPage {
  const c = o.custody;
  const custody: ProofPage["custody"] =
    c === null
      ? { state: "unread", line: "The contract's balance could not be read just now.", detail: "" }
      : c.held >= c.owed
        ? {
            state: "ok",
            line: `The contract holds ${formatUsd(c.held)} USDC and owes ${formatUsd(c.owed)} USDC.`,
            detail: `Both figures were read at block ${c.block} (${utcStamp(c.time)}). It can pay everyone it owes.`,
          }
        : {
            state: "short",
            line: `The contract holds ${formatUsd(c.held)} USDC and owes ${formatUsd(c.owed)} USDC: it is ${formatUsd(c.owed - c.held)} short.`,
            detail: `Both figures were read at block ${c.block} (${utcStamp(c.time)}). This should be impossible; do not pledge.`,
          };

  let second: ProofPage["second"];
  if (o.ledger === null) second = { state: "down", line: KEEPER_DOWN, differences: [] };
  else if (c === null) second = { state: "down", line: "The second ledger cannot be compared until the contract's figures are read.", differences: [] };
  else {
    const s = standing(o.ledger, { owed: c.owed, events: c.events });
    if (s.kind === "behind") {
      const hole = o.ledger.missing;
      const by = `${s.by} ${s.by === 1n ? "event" : "events"}`;
      second = {
        state: "behind",
        line:
          hole === null
            ? `The keeper's ledger is ${by} behind the contract. It is late, not wrong; the figures are compared once it catches up.`
            : `The keeper's ledger is ${by} behind the contract, and ${hole.from === hole.to ? `event ${hole.from}` : `events ${hole.from} to ${hole.to}`} never reached it. It cannot catch up until the Stream delivers them again, and it is not compared until then.`,
        differences: [],
      };
    } else if (s.kind === "ahead") {
      second = { state: "ahead", line: `The keeper's ledger holds ${s.by} more ${s.by === 1n ? "event" : "events"} than this contract has emitted. It is not this contract's ledger, and it is not used.`, differences: [] };
    } else {
      const found = [...s.differences];
      const readIds = new Set(o.campaigns.map((x) => x.id));
      const capped = o.campaigns.length < Number(o.count);
      // The newest read id is the highest; the oldest read id bounds how far back the contract was read.
      const lowestRead = o.campaigns.reduce<bigint | null>((m, x) => (m === null || x.id < m ? x.id : m), null);
      for (const chain of o.campaigns) {
        const mine = o.ledger.campaigns.find((x) => x.id === chain.id);
        if (!mine) found.push(`campaign ${chain.id} is not in the ledger`);
        else for (const d of differences(mine, chain)) found.push(`campaign ${chain.id}: ${d}`);
      }
      // A campaign the page did not read is not "missing from the contract"; only flag those within the read window.
      for (const mine of o.ledger.campaigns) {
        if (!readIds.has(mine.id) && (lowestRead === null || mine.id >= lowestRead)) found.push(`campaign ${mine.id} is in the ledger but not in the contract`);
      }
      let comparedBackers = 0;
      for (const chk of o.backerChecks ?? []) {
        const lc = o.ledger.campaigns.find((x) => x.id === chk.id);
        const lb = lc?.backers.find((b) => b.address.toLowerCase() === chk.address.toLowerCase());
        if (lb === undefined) continue;
        comparedBackers += 1;
        for (const d of backerDifferences(lb, chk.chain)) found.push(`campaign ${chk.id}, backer ${short(chk.address)}: ${d}`);
      }
      const campaignsPhrase = capped
        ? `the newest ${o.campaigns.length} of ${o.count} campaigns`
        : o.campaigns.length === 1
          ? "its one campaign"
          : `all ${o.campaigns.length} campaigns`;
      const backerPhrase = comparedBackers < o.backerTotal ? `${comparedBackers} of ${o.backerTotal} backer records` : `${comparedBackers} backer record${comparedBackers === 1 ? "" : "s"}`;
      second =
        found.length === 0
          ? {
              state: "agrees",
              line: `A second ledger, rebuilt only from the contract's ${c.events} events as the Stream delivered them, agrees with the contract at block ${c.block} on every figure of ${campaignsPhrase} and on ${backerPhrase}.`,
              differences: [],
            }
          : { state: "differs", line: "The second ledger does not agree with the contract. The contract is right; the ledger has been fed something wrong or missed something.", differences: found };
    }
  }

  const h = o.health;
  const stream: Row[] | null =
    h === null
      ? null
      : [
          { label: "Deliveries taken since the keeper started", value: String(h.deliveries) },
          { label: "Last delivery", value: h.lastDeliveryAt === null ? "None yet" : utcStamp(BigInt(Math.floor(h.lastDeliveryAt / 1000))) },
          { label: "Newest block delivered", value: String(h.lastBlock) },
          { label: "Last heartbeat", value: h.lastBeatBlock === null ? "None yet" : `Block ${h.lastBeatBlock}` },
          { label: "Events missing", value: h.missing === null ? "None" : `Numbers ${h.missing.from} to ${h.missing.to}` },
          { label: "Events set aside as not fitting", value: String(h.rejected) },
          { label: "Campaigns in the events that the contract does not have (or not yet)", value: numbers(h.absent) },
          { label: "Calls sent", value: `${h.sent} went through, ${h.failedSends} did not` },
          { label: "Calls given up on", value: h.gaveUp.length === 0 ? "None" : String(h.gaveUp.length) },
          { label: "Stream store", value: h.kvError === null ? "No fault reported" : `Fault reported: ${h.kvError}` },
          { label: "Everything due is settled", value: h.settled ? "Yes" : "Not yet" },
        ];

  return {
    custody,
    second,
    stream,
    keeperErrors: h === null ? [] : h.lastErrors,
    facts: [
      { label: "Contract", value: short(o.where.boomerang), address: o.where.boomerang },
      { label: "Token (USDC)", value: short(o.where.usdc), address: o.where.usdc },
      { label: "Router for pledges from other chains", value: short(o.where.router), address: o.where.router },
      { label: "Owner", value: "None. The contract has no owner, no upgrade, no pause and no way to move funds outside its rules." },
    ],
    yourself: {
      line: "You do not have to trust this page. From a copy of the repository, one command re-checks the live contract without any key: its code, how it was created, that it has no owner, that it holds what it owes, and that its events add up to its state.",
      command: "node scripts/check-live.mjs",
    },
    limits: [...LIMITS],
  };
}
