// Five keyless checks on a live Boomerang, and a sixth on its one-signature helper when one is named, each one row. They read the chain and the kit; they
// send nothing and hold no key. None of them throws: an RPC error becomes that row's failure.
//
//   code     the deployed runtime code is the compiled code, and its one immutable is the USDC address
//   creation the transaction that created the contract carried the compiled creation code and the
//            USDC address and nothing else, so the contract started with no state of anyone's making
//   no-owner the ABI has no privileged function, and the deployed code has no opcode that could
//            run someone else's code as the contract or destroy it
//   custody  the contract holds at least what it owes, read at one block
//   ledger   the event-sourced ledger rebuilt from the logs matches the contract's own state
//   signed-pledge  (when named) SignedPledge's code is the compiled code, bound to this token and this Boomerang
import { keccak256 } from "viem";
import type { Abi, Address, PublicClient } from "viem";

import { applyEvents, decodeLogs, emptyLedger, missing } from "../../packages/kit/src/index.ts";
import type { RawLog } from "../../packages/kit/src/index.ts";
import type { Backer, State } from "../../packages/kit/src/types.ts";

export type Check = { name: string; ok: boolean; detail: string };

type Artifact = {
  abi: readonly unknown[];
  bytecode?: `0x${string}`;
  deployedBytecode: `0x${string}`;
  immutableReferences?: Record<string, { start: number; length: number }[]>;
};

// Function-name patterns a crowdfund with no owner must not have. `rescue` (a sponsor closing a
// campaign's gap) is deliberately not matched: the token-rescue pattern is `rescueTokens`.
// The names are a first screen only. What the row rests on is the code row (the deployed code is
// the compiled code) and the opcode scan below.
const PRIVILEGED =
  /owner|admin|pause|upgrade|sweep|withdraw|rescueTokens|rescueAll|drain|skim|recover|emergency|setFee|setRecipient|initialize|selfdestruct|destroy|kill|migrate|execute|multicall|grantRole/i;

// Opcodes that let other code run with this contract's storage and balance, or remove it.
const FORBIDDEN: Record<number, string> = { 0xf2: "CALLCODE", 0xf4: "DELEGATECALL", 0xff: "SELFDESTRUCT" };

// A 20-byte address, zero-padded to a 32-byte word, as the lowercase hex it sits as in bytecode.
function paddedWord(addr: Address): string {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

// Zero out the immutable byte ranges in a runtime-code hex body (no 0x prefix). Each ref is a
// byte offset and length in the deployed code; one hex char is half a byte.
function maskImmutables(body: string, refs: { start: number; length: number }[]): string {
  const chars = body.split("");
  for (const r of refs) {
    for (let i = r.start * 2; i < (r.start + r.length) * 2 && i < chars.length; i++) chars[i] = "0";
  }
  return chars.join("");
}

// Solidity ends runtime code with a metadata blob (a hash of the sources and the compiler
// version) and that blob's length in the last two bytes. Split a hex body into code and blob.
// A comment edited in a source file changes the blob and nothing else.
function splitMetadata(body: string): { code: string; metadata: string } {
  if (body.length < 4) return { code: body, metadata: "" };
  const size = (parseInt(body.slice(-4), 16) + 2) * 2;
  if (!Number.isFinite(size) || size > body.length) return { code: body, metadata: "" };
  return { code: body.slice(0, body.length - size), metadata: body.slice(body.length - size) };
}

// Walk the instructions of a hex code body, skipping the data bytes of each PUSH, and name any
// forbidden opcode found.
function forbiddenOpcodes(code: string): string[] {
  const found = new Set<string>();
  for (let i = 0; i + 1 < code.length; i += 2) {
    const op = parseInt(code.slice(i, i + 2), 16);
    if (op >= 0x60 && op <= 0x7f) i += (op - 0x5f) * 2;
    else if (FORBIDDEN[op] !== undefined) found.add(FORBIDDEN[op]);
  }
  return [...found];
}

function codeCheck(onChain: `0x${string}` | undefined, usdc: Address, artifact: Artifact): Check {
  if (!onChain || onChain === "0x") return { name: "code", ok: false, detail: "no runtime code at the address" };
  const hash = keccak256(onChain);
  const live = onChain.replace(/^0x/, "").toLowerCase();
  const compiled = artifact.deployedBytecode.replace(/^0x/, "").toLowerCase();
  if (live.length !== compiled.length) {
    return { name: "code", ok: false, detail: `length ${live.length} vs ${compiled.length}; code hash ${hash}` };
  }

  // Boomerang has one immutable, the token. The compiler says where it sits; without that the
  // comparison cannot be made, and the row fails instead of guessing.
  const refs = Object.values(artifact.immutableReferences ?? {}).flat();
  if (refs.length === 0) {
    return { name: "code", ok: false, detail: `the artifact lists no immutable slots; rebuild the contracts; code hash ${hash}` };
  }
  const want = paddedWord(usdc);
  const wrongSlot = refs.find((r) => live.slice(r.start * 2, (r.start + r.length) * 2) !== want);
  if (wrongSlot) {
    const holds = live.slice(wrongSlot.start * 2, (wrongSlot.start + wrongSlot.length) * 2);
    return { name: "code", ok: false, detail: `the token built into the contract is 0x${holds.slice(-40)}, expected ${usdc}; code hash ${hash}` };
  }

  const a = splitMetadata(maskImmutables(live, refs));
  const b = splitMetadata(maskImmutables(compiled, refs));
  if (a.code !== b.code) {
    return { name: "code", ok: false, detail: `differs from compiled code; code hash ${hash}` };
  }
  const exact = a.metadata === b.metadata;
  const detail = exact
    ? `matches compiled code byte for byte; token ${usdc} in ${refs.length} immutable slot(s); code hash ${hash}`
    : `same instructions as compiled code, but the source metadata differs (a comment, a path or a setting that does not change the code); token ${usdc} in ${refs.length} immutable slot(s); code hash ${hash}`;
  return { name: "code", ok: true, detail };
}

// The same runtime code can be put on chain by creation code of someone's own that first writes
// storage (a backer record nobody pledged for, say) and then returns that runtime. The code row
// cannot see that; this row can. It reads the transaction recorded at deployment and requires
// that it created this contract directly and that its input is exactly the compiled creation
// code followed by the token address. The compiler's constructor then decides the starting
// state, and it writes none beyond the token.
async function creationCheck(client: PublicClient, boomerang: Address, usdc: Address, artifact: Artifact, deployTx: `0x${string}` | null | undefined): Promise<Check> {
  const fail = (detail: string): Check => ({ name: "creation", ok: false, detail });
  if (!deployTx) return fail("no deployment transaction is recorded for this contract, so how it was created cannot be checked");
  if (!/^0x[0-9a-fA-F]{64}$/.test(deployTx)) return fail("the recorded deployment transaction is not a transaction hash");
  if (!artifact.bytecode || artifact.bytecode.length <= 2) return fail("the artifact has no creation code; rebuild the contracts");
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash: deployTx }), client.getTransactionReceipt({ hash: deployTx })]);
  if (receipt.status !== "success") return fail(`transaction ${deployTx} did not succeed`);
  if (tx.to !== null || !receipt.contractAddress) return fail(`transaction ${deployTx} did not create a contract directly (it called ${tx.to ?? "nothing"})`);
  if (receipt.contractAddress.toLowerCase() !== boomerang.toLowerCase()) return fail(`transaction ${deployTx} created ${receipt.contractAddress}, not ${boomerang}`);

  const sent = tx.input.replace(/^0x/, "").toLowerCase();
  const compiled = artifact.bytecode.replace(/^0x/, "").toLowerCase();
  const want = paddedWord(usdc);
  if (sent.length !== compiled.length + want.length) return fail(`the creation input is ${sent.length / 2} bytes; the compiled creation code and one address are ${(compiled.length + want.length) / 2}`);
  if (sent.slice(compiled.length) !== want) return fail(`the constructor was given 0x${sent.slice(-40)}, expected ${usdc}`);
  // The creation code ends with the same metadata blob the runtime code ends with. As in the
  // code row, a difference there alone (a comment, a path) is named and allowed.
  const metadata = splitMetadata(artifact.deployedBytecode.replace(/^0x/, "").toLowerCase()).metadata.length;
  const body = compiled.length - metadata;
  if (sent.slice(0, body) !== compiled.slice(0, body)) return fail("the creation code sent is not the compiled creation code");
  const exact = sent.slice(body, compiled.length) === compiled.slice(body);
  return {
    name: "creation",
    ok: true,
    detail: `created directly by transaction ${deployTx} in block ${receipt.blockNumber}; its input is the compiled creation code${exact ? "" : " (source metadata differs)"} and the token address, nothing else`,
  };
}

function noOwnerCheck(onChain: `0x${string}` | undefined, artifact: Artifact): Check {
  const functions = (artifact.abi as { type?: string; name?: string; stateMutability?: string }[]).filter(
    (x) => x.type === "function",
  );
  const flagged = functions.filter((f) => typeof f.name === "string" && PRIVILEGED.test(f.name)).map((f) => f.name);
  const changing = functions
    .filter((f) => f.stateMutability === "nonpayable" || f.stateMutability === "payable")
    .map((f) => f.name);
  if (flagged.length > 0) {
    return { name: "no-owner", ok: false, detail: `privileged function(s): ${flagged.join(", ")}` };
  }
  if (!onChain || onChain === "0x") return { name: "no-owner", ok: false, detail: "no runtime code at the address" };
  // The metadata blob at the end is data, not instructions, and is left out of the scan. How
  // long it is comes from the compiled artifact, never from what the deployed code says of itself.
  const live = onChain.replace(/^0x/, "").toLowerCase();
  const metadata = splitMetadata(artifact.deployedBytecode.replace(/^0x/, "").toLowerCase()).metadata.length;
  const opcodes = forbiddenOpcodes(live.slice(0, Math.max(0, live.length - metadata)));
  if (opcodes.length > 0) {
    return { name: "no-owner", ok: false, detail: `the deployed code contains ${opcodes.join(", ")}` };
  }
  return {
    name: "no-owner",
    ok: true,
    detail: `no ${Object.values(FORBIDDEN).join(", ")} in the deployed code; state-changing functions: ${changing.join(", ")}`,
  };
}

const BALANCE_OF_ABI = [
  { inputs: [{ name: "a", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

async function custodyCheck(client: PublicClient, boomerang: Address, usdc: Address, abi: Abi, blockNumber: bigint): Promise<Check> {
  const held = (await client.readContract({ address: usdc, abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [boomerang], blockNumber })) as bigint;
  const owed = (await client.readContract({ address: boomerang, abi, functionName: "totalOwed", blockNumber })) as bigint;
  const ok = held >= owed;
  return { name: "custody", ok, detail: `holds ${held}, owes ${owed}, at block ${blockNumber}` };
}

// Pull every Boomerang log in [fromBlock, toBlock] in chunks, each with its block's timestamp.
async function logsWithTime(client: PublicClient, boomerang: Address, fromBlock: bigint, toBlock: bigint, chunk: bigint): Promise<RawLog[]> {
  if (chunk < 1n) throw new Error("the log chunk must be at least 1 block");
  const times = new Map<bigint, bigint>();
  const raw: RawLog[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n < toBlock ? start + chunk - 1n : toBlock;
    const logs = await client.getLogs({ address: boomerang, fromBlock: start, toBlock: end });
    for (const lg of logs) {
      const bn = lg.blockNumber!;
      let t = times.get(bn);
      if (t === undefined) {
        t = (await client.getBlock({ blockNumber: bn })).timestamp;
        times.set(bn, t);
      }
      raw.push({ address: lg.address, topics: lg.topics, data: lg.data, blockNumber: bn, blockTimestamp: t });
    }
  }
  return raw;
}

async function ledgerCheck(client: PublicClient, boomerang: Address, abi: Abi, fromBlock: bigint, toBlock: bigint, chunk: bigint): Promise<Check> {
  const raw = await logsWithTime(client, boomerang, fromBlock, toBlock, chunk);
  const ledger = emptyLedger();
  applyEvents(ledger, decodeLogs(raw, boomerang));

  const gap = missing(ledger);
  if (gap !== null) return { name: "ledger", ok: false, detail: `the ledger is waiting for seq ${gap.from}..${gap.to}; a log is missing from the scanned range` };

  const read = <T>(fn: string, args: readonly unknown[] = []) => client.readContract({ address: boomerang, abi, functionName: fn, args, blockNumber: toBlock }) as Promise<T>;
  const eventCount = await read<bigint>("eventCount");
  if (ledger.lastSeq !== eventCount) return { name: "ledger", ok: false, detail: `lastSeq ${ledger.lastSeq} but the contract's eventCount is ${eventCount}` };
  const totalOwed = await read<bigint>("totalOwed");
  if (ledger.totalOwed !== totalOwed) return { name: "ledger", ok: false, detail: `ledger totalOwed ${ledger.totalOwed} but the contract owes ${totalOwed}` };

  const campaignCount = await read<bigint>("campaignCount");
  let backersCompared = 0;
  for (let id = 1n; id <= campaignCount; id++) {
    const c = ledger.campaigns.get(id);
    if (c === undefined) return { name: "ledger", ok: false, detail: `campaign ${id} exists on-chain but not in the ledger` };
    const s = await read<State>("stateOf", [id]);
    const fields: [string, bigint | number | boolean, bigint | number | boolean][] = [
      ["outcome", c.outcome, s.outcome],
      ["matchIn", c.matchIn, s.matchIn],
      ["bonusIn", c.bonusIn, s.bonusIn],
      ["recipientPaid", c.recipientPaid, s.recipientPaid],
      ["matchReturned", c.matchReturned, s.matchReturned],
      ["bonusReturned", c.bonusReturned, s.bonusReturned],
      ["pledged", c.pledged, s.pledged],
      ["pledgedEarly", c.pledgedEarly, s.pledgedEarly],
      ["weighted", c.weighted, s.weighted],
      ["bonusPaid", c.bonusPaid, s.bonusPaid],
      ["backers", BigInt(c.backers.size), BigInt(s.backers)],
    ];
    for (const [name, mine, theirs] of fields) {
      if (mine !== theirs) return { name: "ledger", ok: false, detail: `campaign ${id} ${name}: ledger ${mine} vs contract ${theirs}` };
    }
    for (const [addr, b] of c.backers) {
      const chain = await read<Backer>("backerOf", [id, addr as Address]);
      if (b.principal !== chain.principal) return { name: "ledger", ok: false, detail: `campaign ${id} backer ${addr} principal: ledger ${b.principal} vs contract ${chain.principal}` };
      if (b.weighted !== chain.weighted) return { name: "ledger", ok: false, detail: `campaign ${id} backer ${addr} weighted: ledger ${b.weighted} vs contract ${chain.weighted}` };
      if (b.paid !== chain.paid) return { name: "ledger", ok: false, detail: `campaign ${id} backer ${addr} paid: ledger ${b.paid} vs contract ${chain.paid}` };
      if (b.payTo !== null && b.payTo.toLowerCase() !== chain.payTo.toLowerCase()) {
        return { name: "ledger", ok: false, detail: `campaign ${id} backer ${addr} payTo: ledger ${b.payTo} vs contract ${chain.payTo}` };
      }
      backersCompared++;
    }
  }
  return { name: "ledger", ok: true, detail: `${campaignCount} campaign(s), ${backersCompared} backer(s), seq 1..${ledger.lastSeq} match the contract at block ${toBlock}` };
}

const helperAbi = [
  { type: "function", name: "usdc", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "boomerang", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

// SignedPledge, the one-signature pledge helper: its instructions are the compiled ones (its two
// immutables masked), and the two it holds are this token and this Boomerang, read at one block.
async function helperCheck(client: PublicClient, helper: Address, usdc: Address, boomerang: Address, artifact: Artifact, blockNumber: bigint): Promise<Check> {
  const name = "signed-pledge";
  const onChain = await client.getCode({ address: helper, blockNumber });
  if (!onChain || onChain === "0x") return { name, ok: false, detail: `no runtime code at ${helper}` };
  const hash = keccak256(onChain);
  const live = onChain.replace(/^0x/, "").toLowerCase();
  const compiled = artifact.deployedBytecode.replace(/^0x/, "").toLowerCase();
  const refs = Object.values(artifact.immutableReferences ?? {}).flat();
  if (refs.length === 0) return { name, ok: false, detail: `the helper's artifact lists no immutable slots; rebuild the contracts; code hash ${hash}` };
  if (live.length !== compiled.length || splitMetadata(maskImmutables(live, refs)).code !== splitMetadata(maskImmutables(compiled, refs)).code) {
    return { name, ok: false, detail: `the code at ${helper} is not the compiled SignedPledge; code hash ${hash}` };
  }
  // Every slot the compiler set aside must hold one of the two addresses, each immutable the same
  // one in all its slots, and the two immutables different ones: so the address the calls use is
  // the address the getters show, which are checked next.
  const groups = Object.values(artifact.immutableReferences ?? {}).filter((g) => g.length > 0);
  const allowed = new Set([paddedWord(usdc), paddedWord(boomerang)]);
  const held = groups.map((g) => new Set(g.map((r) => live.slice(r.start * 2, (r.start + r.length) * 2))));
  if (groups.length !== 2 || held.some((h) => h.size !== 1 || !allowed.has([...h][0])) || [...held[0]][0] === [...held[1]][0]) {
    return { name, ok: false, detail: `the addresses built into the code at ${helper} are not this token and this Boomerang, one in every slot of each; code hash ${hash}` };
  }
  const [t, b] = await Promise.all([
    client.readContract({ address: helper, abi: helperAbi, functionName: "usdc", blockNumber }),
    client.readContract({ address: helper, abi: helperAbi, functionName: "boomerang", blockNumber }),
  ]);
  if (t.toLowerCase() !== usdc.toLowerCase()) return { name, ok: false, detail: `the helper's token is ${t}, expected ${usdc}` };
  if (b.toLowerCase() !== boomerang.toLowerCase()) return { name, ok: false, detail: `the helper's boomerang is ${b}, expected ${boomerang}` };
  return { name, ok: true, detail: `${helper} runs the compiled SignedPledge, bound to token ${usdc} and boomerang ${boomerang}; code hash ${hash}` };
}

export async function checkLive(o: {
  client: PublicClient;
  boomerang: Address;
  usdc: Address;
  fromBlock: bigint;
  artifact: Artifact;
  /** The hash of the transaction that created the contract, as the deploy script recorded it. */
  deployTx?: `0x${string}` | null;
  chunk?: bigint;
  /** SignedPledge, when deployed: adds a sixth row. */
  helper?: { address: Address; artifact: Artifact };
}): Promise<Check[]> {
  const { client, boomerang, usdc, fromBlock, artifact } = o;
  const chunk = o.chunk ?? 5000n;
  const abi = artifact.abi as Abi;

  const guard = async (name: string, run: () => Promise<Check>): Promise<Check> => {
    try {
      return await run();
    } catch (e) {
      return { name, ok: false, detail: short(e) };
    }
  };

  // The runtime code is read once and serves two rows.
  let onChain: `0x${string}` | undefined;
  let codeError: string | null = null;
  try {
    onChain = await client.getCode({ address: boomerang });
  } catch (e) {
    codeError = short(e);
  }
  const code = codeError !== null ? { name: "code", ok: false, detail: codeError } : await guard("code", async () => codeCheck(onChain, usdc, artifact));
  const noOwner = codeError !== null ? { name: "no-owner", ok: false, detail: codeError } : await guard("no-owner", async () => noOwnerCheck(onChain, artifact));
  const creation = await guard("creation", () => creationCheck(client, boomerang, usdc, artifact, o.deployTx));

  // One block number for the custody snapshot and the ledger's upper bound, read once.
  let blockNumber: bigint;
  try {
    blockNumber = await client.getBlockNumber();
  } catch (e) {
    const detail = short(e);
    const failed = [code, creation, noOwner, { name: "custody", ok: false, detail }, { name: "ledger", ok: false, detail }];
    return o.helper ? [...failed, { name: "signed-pledge", ok: false, detail }] : failed;
  }
  const custody = await guard("custody", () => custodyCheck(client, boomerang, usdc, abi, blockNumber));
  const ledger = await guard("ledger", () => ledgerCheck(client, boomerang, abi, fromBlock, blockNumber, chunk));
  if (!o.helper) return [code, creation, noOwner, custody, ledger];
  const { address, artifact: helperArtifact } = o.helper;
  const helper = await guard("signed-pledge", () => helperCheck(client, address, usdc, boomerang, helperArtifact, blockNumber));
  return [code, creation, noOwner, custody, ledger, helper];
}

function short(e: unknown): string {
  const err = e as { shortMessage?: string; details?: string; message?: string };
  const msg = e instanceof Error ? err.shortMessage ?? err.message ?? String(e) : String(e);
  const first = msg.split("\n")[0];
  // viem's short message often drops the cause ("An unknown RPC error occurred."); keep it.
  const cause = typeof err.details === "string" && err.details.length > 0 && !first.includes(err.details) ? ` (${err.details.split("\n")[0]})` : "";
  return (first + cause).slice(0, 240);
}
