// Everything the pages show, read in one go at one block. The newest block is fetched once, and
// every figure from the contract and the token is then read at that block's number, so "as of
// block N" on a page is true of every number beside it. The keeper is asked at the same time,
// but it is a second opinion, not part of the picture: it has no block and changes no figure.
import type { PublicClient } from "viem";

import { reader, type Address, type Backer } from "../../../packages/kit/src/index.ts";
import type { KeeperAnswer } from "../data/ask.ts";
import { custodyAt, inBatches, loadCampaigns, loadMine, type CampaignView, type Custody, type MyPledge } from "../data/load.ts";

/** One of the keeper's ledger backer records, paired with the contract's own record read at the same block. */
export type BackerCheck = { id: bigint; address: Address; chain: Backer };

export type World = {
  /** The block every figure below was read at, and that block's time. */
  block: bigint;
  now: bigint;
  /** How many campaigns the contract has; `campaigns` holds the newest fifty of them, newest first. */
  count: bigint;
  campaigns: CampaignView[];
  /** The campaign the page asked for, when the contract has it and it is older than those fifty; read at the same block. */
  extra: CampaignView | null;
  custody: Custody;
  /** The connected account, its pledges, its USDC and what it has allowed the contract to take. */
  account: Address | null;
  mine: MyPledge[];
  balance: bigint | null;
  allowance: bigint | null;
  keeper: KeeperAnswer;
  /** For up to 100 of the keeper's ledger backer records (newest campaigns first), the contract's own record at this block; null when the keeper is down. */
  backerChecks: BackerCheck[] | null;
  /** How many backer records the keeper's ledger lists in all (so the Proof page can say when it compared only some). */
  backerTotal: number;
};

/** How many of the newest campaigns one read takes in. */
export const NEWEST = 50;

const tokenAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export async function readWorld(o: {
  client: PublicClient;
  where: { boomerang: Address; usdc: Address };
  account: Address | null;
  /** Asks the keeper; must not throw (see `askKeeper`). */
  keeper: () => Promise<KeeperAnswer>;
  /** A campaign the page is showing. When the contract has it and it is older than the newest fifty, it is read too, at the same block. */
  also?: bigint | null;
  /** How many of the newest campaigns to read; the page reads `NEWEST`. */
  newest?: number;
}): Promise<World> {
  const keeper = o.keeper(); // started now, awaited last: a slow keeper never delays the contract's figures being read
  const block = await o.client.getBlock();
  const at = { blockNumber: block.number };
  const reads = reader(o.client, o.where.boomerang, block.number);
  const account = o.account;

  const wallet =
    account === null
      ? Promise.resolve<[bigint | null, bigint | null]>([null, null])
      : (Promise.all([
          o.client.readContract({ address: o.where.usdc, abi: tokenAbi, functionName: "balanceOf", args: [account], ...at }),
          o.client.readContract({ address: o.where.usdc, abi: tokenAbi, functionName: "allowance", args: [account, o.where.boomerang], ...at }),
        ]) as Promise<[bigint, bigint]>);

  const [count, newest, custody, [balance, allowance]] = await Promise.all([
    reads.campaignCount(),
    loadCampaigns(reads, o.newest ?? NEWEST),
    custodyAt(o.client, o.where, block),
    wallet,
  ]);
  const also = o.also ?? null;
  const campaigns = newest;
  const extra = also !== null && also >= 1n && also <= count && !newest.some((c) => c.id === also) ? await reads.campaign(also) : null;
  // The account's pledges are looked for in the campaigns read, the asked-for older one among them.
  const mine = account === null ? [] : await loadMine(reads, extra === null ? campaigns : [...campaigns, extra], account);
  const answer = await keeper;

  // For up to 100 of the keeper's ledger backer records (newest campaigns first), read the
  // contract's own record at this same block (through the block-pinned reader), so the Proof page
  // can set the keeper's claims against the contract backer by backer.
  let backerChecks: BackerCheck[] | null = null;
  let backerTotal = 0;
  if (answer.up) {
    const pairs: { id: bigint; address: Address }[] = [];
    const newestFirst = [...answer.ledger.campaigns].sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
    for (const lc of newestFirst) for (const b of lc.backers) pairs.push({ id: lc.id, address: b.address });
    backerTotal = pairs.length;
    backerChecks = await inBatches(pairs.slice(0, 100), 8, async (p) => ({ id: p.id, address: p.address, chain: await reads.backerOf(p.id, p.address) }));
  }

  return { block: block.number, now: block.timestamp, count, campaigns, extra, custody, account, mine, balance, allowance, keeper: answer, backerChecks, backerTotal };
}

/**
 * What the page may show as the connected account's own. The world was read for `world.account`;
 * until a read for `account` lands, nothing of another account's is shown.
 */
export function ownIn(world: World, account: Address | null): { known: boolean; mine: MyPledge[]; balance: bigint | null; allowance: bigint | null } {
  if (account === null || world.account !== account) return { known: false, mine: [], balance: null, allowance: null };
  return { known: true, mine: world.mine, balance: world.balance, allowance: world.allowance };
}

/** The campaign with this number, if it is among those read. */
export function campaignIn(world: World, id: bigint): CampaignView | undefined {
  return world.campaigns.find((c) => c.id === id) ?? (world.extra?.id === id ? world.extra : undefined);
}
