# The QuickNode Stream

**Status:** created at QuickNode and delivering on Arc Testnet since 2026-11-17 (Stream `boomerang-arc-testnet`, from block 72640266, webhook to the keeper on Azure); the keeper accepts every delivery. The filter was also tested locally against QuickNode's documented payload shape.
**Last reconciled:** 2026-11-18 (status and gaps; QuickNode's docs were read at quicknode.com/docs/streams on 2026-11-15).
**Known gaps:** how QuickNode's store reports a failed write (by throwing, or in its return value) is not documented, and the filter only catches a throw; what a read of a list that does not exist returns is not documented either, so the filter treats only an error that names a missing list or key as empty and reports every other error; credits per block on Arc Testnet are not published and are not yet measured; Arc's docs say blocks arrive faster than once a second and that several may share one timestamp (docs.arc.io/integrate/infrastructure, read 2026-11-15), but the actual rate is not yet measured, so the filter's three timing constants are first guesses: at two blocks a second, "every 25th block" is about 12 seconds and the heartbeat about 2.5 minutes.

## What it is for

Boomerang's contract settles itself only when someone calls it: `finalize` at the deadline, then the payouts. Those calls are open to anyone. The Stream is what makes them happen on time without anyone watching: it is the system's only clock.

- No server here polls the chain, and none runs a timer.
- If the Stream is off, nothing breaks: any person can still call `finalize`, `pay`, `payMany` and `paySide` from the app or a block explorer. Payouts are only later.

## Configuration

| Setting | Value | Why |
|---|---|---|
| Network | Arc Testnet (chain 5042002) | where the contract lives |
| Dataset | `block_with_receipts` | the filter needs each block's time (from the block) and its event logs (from the receipts) in one payload |
| Batch size | 1 block | deadlines are checked against every block's time |
| Start | the block the contract was deployed in | so the first `CampaignCreated` is seen |
| Filter | `streams/filter.deployed.js`, the copy of [`streams/filter.js`](../streams/filter.js) that `scripts/deploy.ts` writes with the deployed contract's address (`filter.js` itself holds a zero-address placeholder and would pass nothing) | below |
| Destination | webhook: `POST https://<keeper host>/stream` | the keeper is the only consumer |
| Security | the Stream's security token; the keeper verifies `X-QN-Signature` (HMAC-SHA256 over nonce + timestamp + body) on every delivery | a request without the signature headers is refused before its body is read, and one with a wrong signature before its body is parsed. Someone who held the token could feed the keeper's ledger false events. A false event that fits stays in the ledger, and a false event can keep the true one with its number from being taken, until the keeper's store is cleared and the Stream replayed. The keeper does not take a campaign's outcome from its ledger once the contract has shown it one: asked before every call, the contract's own outcome is what the keeper plans from, so a false "settled", or a false event sitting on the true one's number, does not stop the settlement at the closing second: a campaign falsely called settled is taken for open again after the contract has said so for a minute. The three sides (the recipient, the match, the bonus pool) are put to the contract as well, whatever the ledger says was paid. Two things are not caught. The keeper knows the backers only from its ledger: a false "paid" for a backer, or a false event on the number of a real pledge, leaves that backer out of the keeper's payouts. And an early void (a pot missing at the opening second) is read from the ledger, so a false "pot funded" puts it off until the closing second. It could not make the keeper spend gas on calls that change nothing: before it sends anything the keeper reads the contract and sends only what the contract says will change something, so a false event costs it questions to the contract, not a transaction. And it could not move money the contract holds: every call the keeper can make pays only the addresses the contract's rules name. Anyone can still make the calls by hand, and the keeper's ledger would disagree with the contract's own figures, which is the comparison the Proof page makes |
| Key-Value Store | two lists, `boomerang_open` and `boomerang_final`, created empty before the Stream starts | the filter's memory between blocks. QuickNode's docs do not say how a list that does not exist reads, so they are created first |

## What the filter does

One function, `main(stream)`, with no imports and no network access. For each block:

1. **Pass on Boomerang's logs.** Every log emitted by the contract's address with one of its nine event signatures goes through untouched, with the block's number and time attached. The keeper decodes them and rebuilds each campaign's totals from them alone (the second ledger on the Proof page). Every event carries a sequence number, so a repeat is dropped and a gap is shown as a failure.
2. **Remember deadlines.** On `CampaignCreated` the filter stores `id:opensAt:closesAt` in `boomerang_open`. On `Finalized` it removes the campaign and records its id in `boomerang_final`, so a block replayed after a restart cannot bring it back.
3. **Say when a time has passed.**
   - `opened: [ids]`, once, at the first block at or after a campaign's opening time. What matters is that a delivery arrives at that moment: on every delivery the keeper plans from its own ledger, so it finds a campaign whose opening time has passed with a pot left out (a void campaign) and finalizes it, whether or not the list names it.
   - `due: [ids]` from the first block at or after the deadline, on every block for 10 seconds and then on every 25th block, until the campaign's `Finalized` event is seen. The repeats are the retry: the keeper sends a given call at most once per 20 seconds, so a repeated `due` costs a delivery, not gas.
4. **Send a heartbeat.** Every 300th block is delivered even when empty, marked `beat`. The keeper keeps its own ledger of campaigns from the logs, so a heartbeat lets it settle a campaign whose deadline the filter's store lost. The keeper's `/health` reports the block of the last heartbeat, which is how the Proof page shows that the Stream is alive.
5. **Otherwise deliver nothing.** Any other block with no Boomerang log and no passed time returns `null`. QuickNode bills per block processed whatever the filter returns, so this saves the keeper's bandwidth, not credits.

### When the Key-Value Store fails

- The logs are still delivered, and the delivery carries `kvError`, which the keeper's `/health` shows. While the store is failing every block is delivered, so the keeper still hears the time.
- The record that a campaign is final is written first and on its own. If a read fails, or the write to `boomerang_open` fails, on the block that finalizes a campaign, the next run sees the campaign in `boomerang_final` and clears it from `boomerang_open`.
- If no write reaches `boomerang_final` on that block, the filter keeps announcing the campaign as due on every 25th block. The keeper plans from its own ledger, where the campaign is final, so it makes no call; the cost is one wasted delivery every 25 blocks until the Stream is replayed over that block.
- If the store loses a campaign altogether (the write failed on the block that created it), the filter never announces it. The keeper learned it from the log and settles it on the next delivery of any kind: at worst the next heartbeat, 300 blocks later. Anyone can also call `finalize` by hand.

A delivery looks like this:

```json
{
  "v": 1,
  "fromBlock": 1234567,
  "toBlock": 1234567,
  "time": 1794700000,
  "logs": [{ "address": "0x…", "topics": ["0x…"], "data": "0x…", "blockNumber": "0x12d687", "blockTimestamp": "0x6af8…", "transactionHash": "0x…", "logIndex": "0x0" }],
  "opened": [],
  "due": ["3"]
}
```

## Tests

`node --test streams/` runs the filter as plain source with an in-memory stand-in for the Key-Value Store: 28 cases, including a replayed block, a store that fails on reads, on writes, on one list only or on both, several blocks in one delivery in and out of order, malformed payloads and logs, block numbers given as numbers instead of hex, store errors that must not be read as an empty list, and a check that the nine event signatures in the file equal the compiled contract's.

## Cost and running hours

QuickNode charges Streams by blocks processed. The rate for Arc Testnet is not published; it will be measured on the first day the Stream runs and written here with the date. Arc produces more than 86,400 blocks a day (its blocks are sub-second), so a Stream left running all week processes at least 600,000 blocks. If the free plan cannot carry the Stream all week, it runs in stated windows (the video recording, judging, the finals) and the app says when it is off.
