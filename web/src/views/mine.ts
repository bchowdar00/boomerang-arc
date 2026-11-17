// "My money": each pledge the connected account has made, and where it stands.
import type { Address } from "../../../packages/kit/src/index.ts";
import { hrefFor } from "../app/route.ts";
import { standingOf } from "../data/campaign.ts";
import { short } from "../data/keeper.ts";
import { nameOf, type Label } from "../data/labels.ts";
import type { MyPledge } from "../data/load.ts";
import { formatUsd } from "../data/money.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

export type MineRow = {
  href: string;
  title: string;
  kind: "counted" | "given" | "owed" | "returned";
  line: string;
  /** Where a refund would go, when the backer has pointed it somewhere other than their own address. */
  refundTo: string | null;
  /** Set when a refund is owed and unpaid: anyone may send it, and it pays only the backer. */
  send: { button: string; note: string; campaign: bigint } | null;
};

export type MinePage = {
  /** The account shown, shortened; null when no wallet is connected. */
  account: string | null;
  rows: MineRow[];
  /** What to say when there are no rows. */
  empty: string | null;
  totals: { label: string; value: string }[];
  asOf: string;
};

/**
 * `mine` is what `loadMine` read from the contract. My money takes nothing from the keeper or its
 * ledger: every figure is the contract's own.
 */
export function minePage(o: { account: Address | null; mine: readonly MyPledge[]; labels: readonly Label[]; desk: Address | null; block: bigint }): MinePage {
  const asOf = `As of block ${o.block}`;
  if (o.account === null) return { account: null, rows: [], empty: "Connect a wallet to see your pledges.", totals: [], asOf };
  const me = o.account.toLowerCase();
  let counted = 0n;
  let owed = 0n;
  let returned = 0n;
  let given = 0n;
  let chosen = 0n; // refunds paid to an address this account chose, not back to it
  const rows: MineRow[] = [];
  for (const m of o.mine) {
    const { campaign: c, backer: b } = m;
    const redirectTo = b.payTo.toLowerCase() !== ZERO && b.payTo.toLowerCase() !== me ? b.payTo : null;
    const standing = standingOf(c.terms, c.state, b, redirectTo);
    if (standing.kind === "none") continue;
    if (standing.kind === "counted") counted += standing.principal;
    if (standing.kind === "given") given += standing.principal;
    if (standing.kind === "owed") owed += standing.principal + standing.bonus;
    if (standing.kind === "returned") (redirectTo ? (chosen += standing.principal + standing.bonus) : (returned += standing.principal + standing.bonus));
    rows.push({
      href: hrefFor({ page: "campaign", id: c.id }),
      title: nameOf(o.labels, c, o.desk).title,
      kind: standing.kind,
      line: standing.line,
      refundTo: redirectTo !== null && (standing.kind === "counted" || standing.kind === "owed") ? `A refund would go to ${short(b.payTo)}, as this account asked.` : null,
      send: standing.kind === "owed" ? { button: "Send my refund", note: "Anyone can send this, and it can only pay the address above. The keeper usually does it within seconds.", campaign: c.id } : null,
    });
  }
  const totals = [
    { label: "In open campaigns", value: `${formatUsd(counted)} USDC` },
    { label: "Owed to you now", value: `${formatUsd(owed)} USDC` },
    { label: "Came back to you", value: `${formatUsd(returned)} USDC` },
    { label: "Went to funded campaigns", value: `${formatUsd(given)} USDC` },
  ];
  if (chosen > 0n) totals.push({ label: "Paid to addresses you chose", value: `${formatUsd(chosen)} USDC` });
  return { account: short(o.account), rows, empty: rows.length === 0 ? "This account has not pledged to any campaign here." : null, totals, asOf };
}
