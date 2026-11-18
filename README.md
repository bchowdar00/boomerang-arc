# Boomerang on Arc

A crowdfund where backing early is safe.

A sponsor locks two pots before a campaign opens: a **match**, paid to the recipient only if the target is met, and a **bonus**, paid to early backers only if it is missed. Hit the target and the recipient gets the pledges plus the match. Miss it and every backer gets everything back, with the early backers splitting the bonus. Nobody can withdraw early, and nobody controls the contract.

It is built for a campus club or a community with a sponsor behind it: the sponsor's money does two jobs, and only one of them is ever paid.

**Status:** in progress (UBC 2026 hackathon week). The contracts, the Stream filter, the keeper and the shared library are written and tested on a local chain. The contracts are deployed on Arc Testnet (block 72640266, 2026-11-17 UTC) and pass all six live checks (`node scripts/check-live.mjs`); the page is live at https://boomerang-arc.vercel.app, the Stream delivers to the keeper on Azure, and the Proof page shows both.
**Last reconciled:** 2026-11-16.
**Known gaps:** no deployment; no signed pledge has been sent on Arc, and how common wallets show its typed data is not checked; the cross-chain router has only run against a stand-in for Circle's contracts written from Circle's published source; the Stream filter has only run against QuickNode's documented payload shape, not one recorded from Arc; the page runs against a local chain only; no real campaign has run.

## Where this came from

Boomerang's refund-and-early-bonus mechanism was first designed and built on NEAR for the NEAR Hackathon (Nov 1 to 14, 2026), and not submitted there: https://github.com/bchowdar00/boomerang. This repository is a new implementation on Arc, written during UBC's week: a new contract, new tests and a new app. No code from the NEAR repository is in it.

## How it works

| Outcome | Backers | Recipient | Sponsor |
|---|---|---|---|
| **Funded**: pledges reach the target | pledges go to the recipient | pledges + match | bonus pool returned |
| **Missed**: the deadline passes short | every pledge back in full; early backers split the bonus | nothing | match returned; unpaid bonus returned |
| **Void**: a pot was not locked by opening | no pledge was accepted | nothing | whatever was locked is returned |

A worked example, checked by a test: target 100, bonus pool 10, rate 5%. Alice pledges 30 and Bob 20 in the early window, Carol 10 after it. The campaign misses at 60. Alice gets 30.75 back, Bob 20.50, Carol 10. The sponsor gets the whole match back and 8.75 of the pool.

Before anyone pledges, the contract answers the question a backer actually has: `quoteIfMissed(campaign, amount)` returns what that pledge would bring back if the campaign then missed.

The full rules, what each side can lose, the ways to game it and the risk assumptions are in **[docs/ECONOMICS.md](docs/ECONOMICS.md)**.

## What is built

| Part | Path | What it does |
|---|---|---|
| The contract | `contracts/contracts/Boomerang.sol` | Every campaign rule and all the money. No owner, no upgrade, no pause, no sweep. |
| The cross-chain router | `contracts/contracts/PledgeRouter.sol` | Turns a CCTP mint arriving on Arc into a pledge in one transaction; whatever the campaign does not take goes to the backer's address on Arc. |
| The one-signature pledge | `contracts/contracts/SignedPledge.sol` | A backer signs Circle's USDC transfer authorization once (no transaction, no gas); the keeper submits it, and the helper pledges it in the backer's name. The signature names one campaign, one amount and a three-minute window. If the keeper is down or refuses, the page offers the ordinary two-step pledge. |
| The Stream filter | `streams/filter.js` | A QuickNode Streams filter that passes on Boomerang's events and says when a campaign's deadline has passed. |
| The keeper | `services/keeper/` | Receives the Stream's webhook, rebuilds a ledger from the events alone, and makes the calls that settle a campaign. It has no rights in the contract. |
| The kit | `packages/kit/` | The contract's arithmetic in TypeScript, event decoding and the event-built ledger, each tested equal to the contract. |
| The page | `web/` | Reads the contract from the browser. The pledge form is a cheque: "Pay to the order of" the campaign, "the sum of" what is typed, and beside the button what comes back if the target is missed, in the contract's own figure, before anyone pays. The landing page shows the two endings as a boomerang's flight, plays one campaign through, and lists every campaign on the contract with its outcome, Cleared or Returned. A campaign's own page has what is left to raise, the time left, the early-bonus clock and a chart of the climb. Also your money, and a Proof page that sets the keeper's event-built ledger against the contract at one block. Plain files once built; no server of its own. The design as built: [web/DESIGN.md](web/DESIGN.md). |
| Scripts | `scripts/` | Deploy, demo campaigns, a keyless check of a live deployment, and the whole app on one machine. |

How the parts fit, and what still works when each one stops: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Arc

- The contract takes one token, fixed at deployment: USDC on Arc Testnet (chain 5042002), through its ERC-20 interface at `0x3600000000000000000000000000000000000000` (6 decimals).
- Deadlines are block timestamps.
- A backer on another chain pledges through Circle's CCTP V2: the burn names the router on Arc and carries the campaign and the backer's address as hook data.
- A backer on Arc can pledge with one signature: Circle's EIP-3009 `receiveWithAuthorization` on USDC (EIP-712 domain "USDC", version "2", which Arc Testnet's USDC answers), payable only to `SignedPledge`, with a nonce that binds the campaign and the amount. Not EIP-2612 `permit`, which cannot bind the campaign.

### Addresses

| Contract | Arc Testnet |
|---|---|
| Boomerang | [`0x03Aa341b3128fD5d742bCCE00133791a6bcE7F97`](https://explorer.testnet.arc.io/address/0x03Aa341b3128fD5d742bCCE00133791a6bcE7F97) |
| PledgeRouter | [`0xc9e2b828f63e104dfe6d67bdb7bfc2e76cc67b2a`](https://explorer.testnet.arc.io/address/0xc9e2b828f63e104dfe6d67bdb7bfc2e76cc67b2a) |
| SignedPledge | [`0x2eef524e9c7ea4d8fd1a7e771aca60e1010cb87a`](https://explorer.testnet.arc.io/address/0x2eef524e9c7ea4d8fd1a7e771aca60e1010cb87a) |
| USDC (Circle) | `0x3600000000000000000000000000000000000000` |
| CCTP MessageTransmitterV2 (Circle) | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| CCTP TokenMessengerV2 (Circle) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |

## QuickNode Streams

The contract does nothing by itself at a deadline: someone has to call `finalize` and the payouts. A QuickNode Stream is what makes that happen on time. No server here polls the chain or runs a timer; the Stream is the only clock and the only source of chain data the keeper has.

| | |
|---|---|
| Network | Arc Testnet |
| Dataset | `block_with_receipts` (each block's time and its event logs in one payload) |
| Filter | [`streams/filter.js`](streams/filter.js), JavaScript, using the Key-Value Store |
| Destination | a webhook, `POST /stream` on the keeper, verified by the Stream's HMAC signature |

**Filter logic.** For each block the filter (1) passes on every event log from the Boomerang contract, with the block's number and time; (2) keeps each open campaign's opening time and deadline in the Key-Value Store, learned from the contract's own `CampaignCreated` and `Finalized` events; (3) says `opened` once when a campaign opens and `due` from its deadline until its `Finalized` event is seen; (4) sends a bare heartbeat every 300th block; (5) delivers nothing otherwise.

**What the keeper does with it.** It rebuilds each campaign's totals from the events alone, in sequence-number order, and on every delivery works out from that ledger which calls would move a campaign forward. Those calls are open to anyone, so if the Stream or the keeper is off, payouts are only later, never lost.

Details, the behaviour when the Key-Value Store fails, and cost: **[docs/STREAM.md](docs/STREAM.md)**.

## Run it

Needs Node 26.

```bash
npm install
```

```bash
npm test
```

`npm test` runs the contract tests on Hardhat's in-memory chain (the rules with worked numbers, the attack table, a random walk that checks custody after every action, the router, the kit against the contract, the keeper against the contract, the scripts, the app's reading of the keeper's ledger), then the keeper's own tests, the Stream filter's and the app's.

One of those tests runs the whole pipeline with nothing built by hand in between (`contracts/test/pipeline.test.ts`): the contract's receipts, as the node's JSON-RPC gives them, go through `streams/filter.js`; each thing the filter returns is signed and posted to the keeper's HTTP server; the keeper calls the contract. The only stand-in is for QuickNode itself, the thing that runs the filter once per block.

The whole app on one machine, with nothing deployed and no wallet extension (a local node, the contracts, three example campaigns, the keeper with its desk, a local stand-in for the Stream, and the page at `http://127.0.0.1:5173/`):

```bash
cd contracts && npx hardhat build
```

```bash
node scripts/dev-local.mjs
```

It touches no network. The page offers a "Local test wallet", which is one of the local node's own unlocked test accounts; that wallet exists only when the page is pointed at a local chain and stops the app if it is set for Arc Testnet.

Deploying, and checking a deployment without any key:

```bash
cd contracts && npx hardhat keystore set ARC_DEPLOYER_KEY
```

```bash
cd contracts && npx hardhat run ../scripts/deploy.ts --network arcTestnet
```

```bash
node scripts/check-live.mjs
```

`check-live.mjs` holds no key and sends nothing. It exits 0 when every check passes, 1 when one fails, and 2 when it could not check (it says what is missing). The token it holds the contract to, Circle's USDC on Arc Testnet, is written in the script and not read from the addresses file. It checks five things: the deployed code is this repository's and was built with Circle's USDC address; the transaction that created the contract carried this repository's creation code and that address and nothing else, so the contract began with no state of anyone's making; the ABI has no owner functions and the deployed code has no `DELEGATECALL`, `CALLCODE` or `SELFDESTRUCT`; the contract holds at least what it owes at one block; and a ledger rebuilt from the events equals the contract's own state.

## What is defended, and what is not

**[docs/ATTACKS.md](docs/ATTACKS.md)** lists each attack considered, the rule that answers it, what remains, and the test that shows it. Three things it says plainly:

- The contract cannot see who owns a wallet. A recipient can back its own campaign to collect the match, and a sponsor's friends can pledge early to collect the bonus on a miss. The loss is capped by the pots the sponsor chose to lock.
- A bug cannot be patched. There is no upgrade path; the answer to a bug is a new deployment.
- Testnet only. Nothing here has held real money.

## Not claimed

- That backers will behave as they did in the lab studies or the earlier simulation cited in ECONOMICS.md.
- That pledging early is anyone's best move in every case.
- Any legal conclusion about refund bonuses.

## License

MIT. See [LICENSE](LICENSE).
