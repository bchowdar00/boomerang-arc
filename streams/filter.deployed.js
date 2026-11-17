// Boomerang's QuickNode Stream filter. Network: Arc Testnet. Dataset: block_with_receipts.
//
// It does three things and nothing else:
//   1. passes on every Boomerang event log, untouched, with its block number and block time;
//   2. keeps each open campaign's opening time and deadline in the Key-Value Store, learned
//      from the contract's own CampaignCreated and Finalized events;
//   3. says when a stored time has passed: `opened` once when a campaign opens, and `due`
//      from its deadline until its Finalized event is seen;
//   4. sends a bare heartbeat every HEARTBEAT_EVERY blocks, so the keeper hears the time
//      now and then even if the store lost track of a campaign.
// A block with none of these is not delivered (the filter returns null).
//
// The filter is the only clock in the system. The keeper that receives these deliveries
// has no timer and polls nothing; it calls `finalize` and the payout functions, which are
// open to anyone, when a delivery says a campaign is due.
//
// Rules of the sandbox: one function named `main`, no imports, no network, no eval.
// `qnLib` is QuickNode's Key-Value Store library, provided by the sandbox.

// The deployed Boomerang contract, lowercase. scripts/deploy writes the real address here.
const BOOMERANG = "0x03aa341b3128fd5d742bcce00133791a6bce7f97";

// keccak256 of each event signature. streams/filter.test.mjs checks them against the ABI.
const TOPICS = {
  "0x2dcca4cae330ebeb7315c4cb2a07b0dc1532b0f0fb27598eaf80583964f8aa01": "CampaignCreated",
  "0xe2130dce4f0f68f41020f1bb865547c96b6197c46fb26ab231179682c3b2d967": "PotFunded",
  "0xa4b0edb050ae5b4745defcfe7b31f2c8ce881b1e775702cb2d9eddb6092aae02": "Pledged",
  "0x81221b59451595264a069a70637d068bf41462d0ac95b9a9e2fb2b13b963f668": "Rescued",
  "0xcb2e66cde9f053286949ba6c17398a169a1af87953c06ce4dfff582be4ed2a10": "Finalized",
  "0x3d571b7f63f88b8c3cbaa392a0e0914e91a55a148a3852ec6fe2d3b193d32d92": "Paid",
  "0x720e7eda8132919aa582b3b63d5a9ba9c0dbc3aeac54de4a0e6bd8424abb0ac2": "PayFailed",
  "0x710102cf1828e301021bb5f7c410e9e77b5532a38036dab099ee0b1d10dc7156": "SidePaid",
  "0x94bd2afa591916844a365867c5e3bbfc433059cb0e593a70da75e55decc3dc97": "Redirected",
};

// Key-Value Store lists. An open campaign is one item, "id:opensAt:closesAt"; opensAt is 0
// once its opening has been announced. A finalized campaign's id moves to the second list,
// so that a block replayed after a restart cannot bring it back.
const OPEN_LIST = "boomerang_open";
const FINAL_LIST = "boomerang_final";

// A due campaign is announced on every block for this many seconds after its deadline, and
// after that on every DUE_EVERY-th block, until its Finalized event is seen. The keeper's
// calls are harmless to repeat, so the repeats are the retry.
const DUE_EAGER_SECONDS = 10;
const DUE_EVERY = 25;

// The keeper keeps its own ledger of campaigns from the logs. A heartbeat lets it act on that
// ledger if this filter's store ever missed a campaign (a failed write, a wiped list).
const HEARTBEAT_EVERY = 300;

async function main(stream) {
  const logs = [];
  const created = []; // { id, opensAt, closesAt }
  const finalized = []; // ids
  let fromBlock = null;
  let toBlock = null;
  let time = 0;

  for (const entry of list(stream && stream.data)) {
    const block = (entry && entry.block) || {};
    const number = quantity(block.number);
    const blockTime = quantity(block.timestamp);
    // Blocks normally arrive in order; the lowest and highest are kept either way.
    if (Number.isFinite(number)) {
      if (fromBlock === null || number < fromBlock) fromBlock = number;
      if (toBlock === null || number > toBlock) toBlock = number;
    }
    if (Number.isFinite(blockTime) && blockTime > time) time = blockTime;

    for (const receipt of list(entry && entry.receipts)) {
      for (const log of list(receipt && receipt.logs)) {
        if (!log || typeof log.address !== "string" || log.address.toLowerCase() !== BOOMERANG) continue;
        const topic0 = Array.isArray(log.topics) && typeof log.topics[0] === "string" ? log.topics[0].toLowerCase() : null;
        const name = own(TOPICS, topic0) && TOPICS[topic0];
        // Every Boomerang event has the signature, seq and id as 32-byte topics and hex data,
        // and CampaignCreated carries eleven words of it. Anything else is not one of ours.
        if (!name || !WORD.test(log.topics[1]) || !WORD.test(log.topics[2]) || !HEX.test(log.data)) continue;
        if (name === "CampaignCreated" && log.data.length < 2 + 64 * 11) continue;
        logs.push({
          address: log.address,
          topics: log.topics,
          data: log.data,
          blockNumber: block.number,
          blockTimestamp: block.timestamp,
          transactionHash: log.transactionHash || receipt.transactionHash,
          logIndex: log.logIndex,
        });
        // topics: [signature, seq, id, ...]. Terms is a static struct, so the data of
        // CampaignCreated is its eleven fields in order: opensAt is word 1, closesAt word 3.
        const id = BigInt(log.topics[2]).toString();
        if (name === "CampaignCreated") {
          created.push({ id, opensAt: word(log.data, 1), closesAt: word(log.data, 3) });
        } else if (name === "Finalized") {
          finalized.push(id);
        }
      }
    }
  }

  // What the store knows, then what this delivery adds and removes.
  let kvError = null;
  const open = new Map(); // id -> { opensAt, closesAt, item }
  let knownFinal = new Set();
  const add = [];
  const remove = [];
  try {
    knownFinal = new Set((await getList(FINAL_LIST)).map(String));
    for (const item of await getList(OPEN_LIST)) {
      const [id, opensAt, closesAt] = String(item).split(":");
      if (!id || !closesAt) continue;
      // An open item whose campaign is already recorded as final is left over from a
      // delivery where the store failed half way. Clear it instead of announcing it forever.
      if (knownFinal.has(id)) remove.push(item);
      else open.set(id, { opensAt: Number(opensAt), closesAt: Number(closesAt), item });
    }
  } catch (e) {
    kvError = String((e && e.message) || e);
  }
  for (const c of created) {
    if (open.has(c.id) || knownFinal.has(c.id) || finalized.includes(c.id)) continue;
    const item = c.id + ":" + c.opensAt + ":" + c.closesAt;
    open.set(c.id, { opensAt: c.opensAt, closesAt: c.closesAt, item });
    add.push(item);
  }
  for (const id of finalized) {
    const known = open.get(id);
    if (!known) continue;
    open.delete(id);
    if (add.includes(known.item)) add.splice(add.indexOf(known.item), 1);
    else remove.push(known.item);
  }

  // Which stored times has this block passed?
  const opened = [];
  const due = [];
  for (const [id, c] of open) {
    if (time >= c.closesAt) {
      if (time < c.closesAt + DUE_EAGER_SECONDS || crosses(fromBlock, toBlock, DUE_EVERY)) due.push(id);
    } else if (c.opensAt !== 0 && time >= c.opensAt) {
      opened.push(id);
      const announced = id + ":0:" + c.closesAt;
      if (add.includes(c.item)) add.splice(add.indexOf(c.item), 1);
      else remove.push(c.item);
      add.push(announced);
    }
  }

  // The final list is written first and on its own. If only the open list's write fails,
  // the next run finds the campaign in the final list and clears it from the open one.
  try {
    if (finalized.length > 0) await qnLib.qnUpsertList(FINAL_LIST, { add_items: finalized });
  } catch (e) {
    kvError = String((e && e.message) || e);
  }
  try {
    if (add.length > 0 || remove.length > 0) {
      await qnLib.qnUpsertList(OPEN_LIST, { add_items: add, remove_items: remove });
    }
  } catch (e) {
    kvError = String((e && e.message) || e);
  }

  const beat = crosses(fromBlock, toBlock, HEARTBEAT_EVERY);
  if (logs.length === 0 && due.length === 0 && opened.length === 0 && kvError === null && !beat) return null;
  const delivery = { v: 1, fromBlock, toBlock, time, logs, opened, due };
  if (beat) delivery.beat = true;
  if (kvError !== null) delivery.kvError = kvError;
  return delivery;
}

// True when some block number in [from, to] is a multiple of `every`.
function crosses(from, to, every) {
  if (from === null || to === null) return false;
  return Math.floor(to / every) > Math.floor((from - 1) / every);
}

// A list that does not exist yet reads as empty, whether the store answers with nothing or
// with an error that says the list or key is not there. QuickNode does not document which,
// so the match is narrow on purpose: any other failure (a host that cannot be found, a
// status code) is passed up and reported, never read as an empty list.
const MISSING_LIST = /\b(list|key)\b[^.]*\b(not found|does not exist)\b|\b(not found|does not exist)\b[^.]*\b(list|key)\b/i;
async function getList(name) {
  try {
    const items = await qnLib.qnGetList(name);
    return Array.isArray(items) ? items : [];
  } catch (e) {
    if (MISSING_LIST.test(String((e && e.message) || e))) return [];
    throw e;
  }
}

// What the payload should hold as an array, or nothing if it holds something else.
function list(value) {
  return Array.isArray(value) ? value : [];
}

// A block number or time: a 0x hex string as the chain's JSON gives it, a string of digits
// (read as decimal, never as hex), or already a number. Anything else is not a quantity.
function quantity(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return NaN;
  if (/^0x[0-9a-fA-F]+$/.test(value)) return parseInt(value, 16);
  return /^[0-9]+$/.test(value) ? parseInt(value, 10) : NaN;
}

// Only the table's own keys count; "constructor" and the like are not event signatures.
function own(table, key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key);
}

const WORD = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x[0-9a-fA-F]*$/;

// The i-th 32-byte word of hex data, as a number. Times fit easily.
function word(data, i) {
  return Number(BigInt("0x" + data.slice(2 + 64 * i, 2 + 64 * (i + 1))));
}
