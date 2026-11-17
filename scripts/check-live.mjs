// A keyless check anyone can run against the live Boomerang:
//
//   node scripts/check-live.mjs [--rpc <url>]
//
// It reads the chain and prints one PASS/FAIL line per check. It holds no key and sends no
// transaction. Exit 0: every check passed. Exit 1: a check ran and failed. Exit 2: it could not
// check (nothing deployed yet, or the deployment record is incomplete), said why, and did not
// touch the network.
// It imports lib/check.ts directly; Node strips the TypeScript types.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createPublicClient, http } from "viem";

import { arcTestnet } from "../packages/kit/src/index.ts";
import { checkLive } from "./lib/check.ts";

const ARC_CHAIN_ID = 5042002;
// Circle's USDC on Arc Testnet, written here and not taken from addresses.json: the file this
// check is checking must not be the one to say which token counts.
const ARC_USDC = "0x3600000000000000000000000000000000000000";
// Another addresses file, for this script's own tests. The token above is not read from it.
const addressesFile = process.env.BOOMERANG_ADDRESSES_FILE;
const here = new URL(".", import.meta.url);
const addressesPath = addressesFile ? new URL(addressesFile, `file://${process.cwd()}/`) : new URL("../packages/kit/addresses.json", here);
const artifactPath = new URL("../contracts/artifacts/contracts/Boomerang.sol/Boomerang.json", here);
const helperArtifactPath = new URL("../contracts/artifacts/contracts/SignedPledge.sol/SignedPledge.json", here);

function parseRpc(argv) {
  const i = argv.indexOf("--rpc");
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return arcTestnet.rpcUrls.default.http[0];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// Everything this script needs to be told before it can check anything. A missing or malformed
// piece exits 2 with what to do about it; exit 1 is kept for a check that ran and failed.
function stop(message) {
  console.error(message);
  process.exit(2);
}

async function main() {
  // Resolve the deployed addresses before anything else; a chain that is not deployed yet exits
  // here, before any network client is built.
  let raw;
  try {
    raw = JSON.parse(await readFile(addressesPath, "utf8"))[String(ARC_CHAIN_ID)];
  } catch {
    stop("The addresses file could not be read.");
  }
  if (!raw || typeof raw.boomerang !== "string" || !ADDRESS.test(raw.boomerang)) {
    stop(`Boomerang is not deployed on chain ${ARC_CHAIN_ID} yet (addresses.json has no address for it). Deploy it first with scripts/deploy.ts.`);
  }
  if (!(typeof raw.deployBlock === "number" && Number.isSafeInteger(raw.deployBlock) && raw.deployBlock >= 0) && !(typeof raw.deployBlock === "string" && /^[0-9]{1,15}$/.test(raw.deployBlock))) {
    stop(`addresses.json has an address for chain ${ARC_CHAIN_ID} but no usable deployBlock; re-run scripts/deploy.ts to record it.`);
  }
  if (typeof raw.boomerangTx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw.boomerangTx)) {
    stop(`addresses.json has an address for chain ${ARC_CHAIN_ID} but no deployment transaction (boomerangTx); re-run scripts/deploy.ts to record it. Without it the check cannot tell how the contract was created.`);
  }
  if (typeof raw.usdc === "string" && raw.usdc.toLowerCase() !== ARC_USDC) {
    stop(`addresses.json names ${raw.usdc} as the token; on Arc Testnet this check accepts only Circle's USDC, ${ARC_USDC}.`);
  }
  const fromBlock = BigInt(raw.deployBlock);
  let artifact;
  try {
    artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  } catch {
    stop("The compiled contract is not here. Build it first: cd contracts && npx hardhat build");
  }

  const rpc = parseRpc(process.argv.slice(2));
  const client = createPublicClient({ chain: arcTestnet, transport: http(rpc) });

  // The one-signature pledge helper, when the deployment recorded one: a sixth row.
  let helper;
  if (raw.signedPledge !== undefined && raw.signedPledge !== null) {
    if (typeof raw.signedPledge !== "string" || !ADDRESS.test(raw.signedPledge)) stop("addresses.json names a signedPledge that is not an address; re-run scripts/deploy.ts.");
    let helperArtifact;
    try {
      helperArtifact = JSON.parse(await readFile(helperArtifactPath, "utf8"));
    } catch {
      stop("The compiled SignedPledge is not here. Build it first: cd contracts && npx hardhat build");
    }
    helper = { address: raw.signedPledge, artifact: helperArtifact };
  }

  const rows = await checkLive({ client, boomerang: raw.boomerang, usdc: ARC_USDC, fromBlock, artifact, deployTx: raw.boomerangTx, helper });
  let allOk = true;
  for (const r of rows) {
    if (!r.ok) allOk = false;
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}  ${r.detail}`);
  }
  process.exit(allOk ? 0 : 1);
}

await main();
