// A stand-in for the QuickNode Stream, for a local chain only.
//
// On Arc the Stream runs streams/filter.js for every block and posts what it returns to the
// keeper, signed. On a developer's machine there is no QuickNode, so this does the same three
// things by hand: it builds each block's payload from the node's own JSON-RPC answers (the
// `block_with_receipts` shape: the block, and the receipt of each of its transactions), runs
// the very same filter source over it with an in-memory Key-Value Store, and posts the result
// with the same three signature headers. Nothing here runs in production; it exists so the
// filter and the keeper are tested together, and so the app can be developed offline.
import { createHmac, randomBytes } from "node:crypto";
import vm from "node:vm";

type Json = Record<string, unknown>;
type Request = (args: { method: string; params?: unknown[] }) => Promise<unknown>;

/** The two Key-Value Store calls the filter makes, kept in memory. */
export function memoryKv() {
  const lists = new Map<string, Set<string>>();
  const qnLib = {
    async qnGetList(name: string): Promise<string[]> {
      return [...(lists.get(name) ?? [])];
    },
    async qnUpsertList(name: string, change: { add_items?: string[]; remove_items?: string[] }): Promise<void> {
      const set = lists.get(name) ?? new Set<string>();
      for (const x of change.remove_items ?? []) set.delete(x);
      for (const x of change.add_items ?? []) set.add(x);
      lists.set(name, set);
    },
  };
  return { qnLib, list: (name: string): string[] => [...(lists.get(name) ?? [])].sort() };
}

/**
 * Load the filter as QuickNode does: as plain source, with only `qnLib` in scope. The one line
 * that names the contract is pointed at `boomerang`, exactly as scripts/deploy does.
 */
export function loadFilter(source: string, boomerang: string, kv: ReturnType<typeof memoryKv> = memoryKv()) {
  const line = /^(.*const BOOMERANG = ")0x0{40}(";.*)$/gm;
  if ((source.match(line) ?? []).length !== 1) throw new Error("filter: expected exactly one BOOMERANG placeholder line");
  const context = vm.createContext({ qnLib: kv.qnLib });
  vm.runInContext(source.replace(line, `$1${boomerang.toLowerCase()}$2`), context);
  const main = vm.runInContext("main", context) as (stream: unknown) => Promise<Json | null>;
  return { main, kv };
}

/** One block as the `block_with_receipts` dataset carries it, from the node's raw answers. */
export async function blockWithReceipts(request: Request, blockNumber: bigint): Promise<{ block: Json; receipts: Json[] }> {
  const block = (await request({ method: "eth_getBlockByNumber", params: [`0x${blockNumber.toString(16)}`, false] })) as Json | null;
  if (!block) throw new Error(`no block ${blockNumber}`);
  const receipts: Json[] = [];
  for (const hash of (block.transactions as string[]) ?? []) {
    const receipt = (await request({ method: "eth_getTransactionReceipt", params: [hash] })) as Json | null;
    if (receipt) receipts.push(receipt);
  }
  return { block, receipts };
}

/** The three headers QuickNode signs a delivery with: HMAC-SHA256 over nonce + timestamp + body. */
export function signedHeaders(secret: string, body: string, now: number = Date.now()): Record<string, string> {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = String(Math.floor(now / 1000));
  const signature = createHmac("sha256", Buffer.from(secret)).update(nonce + timestamp + body).digest("hex");
  return { "content-type": "application/json", "x-qn-nonce": nonce, "x-qn-timestamp": timestamp, "x-qn-signature": signature };
}

/**
 * Run the filter over blocks `from`..`to`, one block per run as the Stream is configured, and
 * hand each thing it returns to `post`. Returns what was delivered, in order.
 */
export async function streamBlocks(o: {
  request: Request;
  filter: { main: (stream: unknown) => Promise<Json | null> };
  from: bigint;
  to: bigint;
  post: (body: string) => Promise<void>;
}): Promise<Json[]> {
  const delivered: Json[] = [];
  for (let n = o.from; n <= o.to; n += 1n) {
    const entry = await blockWithReceipts(o.request, n);
    const out = await o.filter.main({ data: [entry], metadata: { network: "local", dataset: "block_with_receipts" } });
    if (out === null || out === undefined) continue;
    await o.post(JSON.stringify(out));
    delivered.push(out);
  }
  return delivered;
}
