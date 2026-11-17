// The keeper's entry point. It reads its settings from the environment, opens the store, builds
// the keeper (watch-only without a key, a signer with one), optionally stands up the demo desk,
// and serves. The token and the private key are read once and then wiped from the process's own
// environment; they are never logged and never written.
//
// Not to be run against any live network from a review session: it talks to a real RPC.
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { makeQueue, makeSender } from "./chain.ts";
import { createDesk, type Desk } from "./demo.ts";
import { createRelay, type Relay } from "./relay.ts";
import { createKeeper, type Sender } from "./keeper.ts";
import { createServer } from "./server.ts";
import { settingsFrom, SettingsError, type Settings } from "./settings.ts";
import { openStore } from "./store.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// The settings are read, and the two secrets are wiped from the environment before anything
// else happens, including before the process exits on a bad setting.
let settings: Settings | undefined;
let problem: string | undefined;
try {
  settings = settingsFrom(process.env);
} catch (e) {
  // Only the settings' own fixed messages are printed; anything else could carry a value.
  problem = e instanceof SettingsError ? e.message : "the keeper's settings could not be read";
}
delete process.env.STREAM_SECURITY_TOKEN;
delete process.env.KEEPER_PRIVATE_KEY;
if (settings === undefined) fail(problem ?? "the keeper's settings could not be read");
const { secret, chain, rpcUrl, boomerang, usdc, port, dataDir } = settings;

const store = openStore(dataDir);
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

let walletClient: ReturnType<typeof createWalletClient> | undefined;
let sender: Sender;
let signer = "watch-only";

// Everything this account sends waits in one line, so the keeper's calls and the demo desk's
// transfers never go out at the same moment with the same nonce.
const queue = makeQueue();

if (settings.key !== null) {
  let account;
  try {
    account = privateKeyToAccount(settings.key as `0x${string}`);
  } catch {
    // The library's own message is not printed: it must never carry any part of the key.
    fail("KEEPER_PRIVATE_KEY is not a valid private key");
  }
  settings.key = null;
  walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const direct = makeSender({ publicClient, walletClient, boomerang });
  sender = (action) => queue(() => direct(action));
  signer = account.address;
} else {
  sender = async () => ({ ok: false, error: "no signer" });
}

// Waits between sends are measured on the process's own forward-only clock, which no delivery
// and no change to the machine's date can move.
const keeper = createKeeper({ boomerang, store, send: sender, timer: () => BigInt(Math.floor(performance.now() / 1000)) });

let desk: Desk | undefined;
if (walletClient && settings.demoRecipient) {
  desk = createDesk({ publicClient, walletClient, boomerang, usdc, recipient: settings.demoRecipient, store, ledger: () => keeper.ledger, queue });
}

// One-signature pledges, sent from the same account through the same line, when the helper is deployed.
let relay: Relay | undefined;
if (walletClient && settings.signedPledge) {
  relay = createRelay({ publicClient, walletClient, signedPledge: settings.signedPledge, usdc, queue, timer: () => BigInt(Math.floor(performance.now() / 1000)) });
}

const server = createServer({ keeper, secret, desk, relay, log: (line) => console.log(line) });
server.listen(port, settings.host, () => {
  console.log(`keeper on ${settings.host}:${port} chain ${chain.id}${settings.local ? " (local)" : ""} boomerang ${boomerang} signer ${signer} desk ${desk ? "on" : "off"} relay ${relay ? "on" : "off"}`);
});
