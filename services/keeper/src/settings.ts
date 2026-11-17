// The keeper's settings, read from the environment in one place and refused by name when one is
// wrong. Nothing here prints or keeps a secret's text beyond handing it back to the caller.
//
// The keeper runs against Arc Testnet. The one other thing it will run against is a node on this
// machine (CHAIN_ID set to something else), for the local demo loop: then the RPC must be a
// loopback address and both contract addresses must be given, so a local setting can never point
// a real key at some other network.
import { isIP } from "node:net";

import { defineChain, isAddress, type Chain } from "viem";

import { addressesFor, arcTestnet, type Address } from "../../../packages/kit/src/index.ts";

export type Settings = {
  secret: string;
  /** The signer's private key as given, or null for a keeper that only watches. */
  key: string | null;
  chain: Chain;
  rpcUrl: string;
  local: boolean;
  boomerang: Address;
  usdc: Address;
  port: number;
  /** The address the server listens on. This machine only, unless HOST says otherwise. */
  host: string;
  dataDir: string;
  demoRecipient: Address | null;
  /** SignedPledge, the helper the relay submits one-signature pledges through; null turns the relay off. */
  signedPledge: Address | null;
};

export class SettingsError extends Error {}

type Env = Record<string, string | undefined>;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const given = (env: Env, name: string): string | undefined => (env[name] === undefined || env[name] === "" ? undefined : env[name]);

// An address from the environment, or undefined when the variable is not set. A value that is
// set but is not an address stops the keeper instead of being passed on.
function addressFrom(env: Env, name: string): Address | undefined {
  const value = given(env, name);
  if (value === undefined) return undefined;
  if (!isAddress(value, { strict: false })) throw new SettingsError(`${name} is not an address`);
  return value as Address;
}

// The RPC's address. Its text is never put in a message: a provider's URL often carries a key.
function rpcFrom(env: Env, o: { localOnly: boolean }): string | undefined {
  const value = given(env, "RPC_URL");
  if (value === undefined) return undefined;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new SettingsError("RPC_URL is not a URL");
  }
  const local = LOCAL_HOSTS.has(u.hostname);
  if (o.localOnly && !local) throw new SettingsError("RPC_URL must be on this machine (127.0.0.1 or localhost) when CHAIN_ID is not Arc Testnet's");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new SettingsError("RPC_URL must be https (http is allowed only on this machine)");
  return value;
}

export function settingsFrom(env: Env, deployed: (chainId: number) => { boomerang: Address; usdc: Address; signedPledge?: Address | null } = addressesFor): Settings {
  const secret = given(env, "STREAM_SECURITY_TOKEN");
  if (!secret) throw new SettingsError("STREAM_SECURITY_TOKEN is required");

  const idText = given(env, "CHAIN_ID") ?? String(arcTestnet.id);
  if (!/^[0-9]{1,9}$/.test(idText)) throw new SettingsError("CHAIN_ID is not a chain id");
  const id = Number(idText);
  const local = id !== arcTestnet.id;

  let boomerang = addressFrom(env, "BOOMERANG_ADDRESS");
  let usdc = addressFrom(env, "USDC_ADDRESS");
  let signedPledge = addressFrom(env, "SIGNED_PLEDGE_ADDRESS");
  let chain: Chain;
  let rpcUrl: string;
  if (local) {
    const rpc = rpcFrom(env, { localOnly: true });
    if (rpc === undefined) throw new SettingsError("RPC_URL is required when CHAIN_ID is not Arc Testnet's");
    if (!boomerang) throw new SettingsError("BOOMERANG_ADDRESS is required when CHAIN_ID is not Arc Testnet's");
    if (!usdc) throw new SettingsError("USDC_ADDRESS is required when CHAIN_ID is not Arc Testnet's");
    rpcUrl = rpc;
    chain = defineChain({ id, name: `Local chain ${id}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } }, testnet: true });
  } else {
    let fromKit: { boomerang: Address; usdc: Address; signedPledge?: Address | null } | undefined;
    try {
      fromKit = deployed(arcTestnet.id);
    } catch {
      fromKit = undefined;
    }
    boomerang = boomerang ?? fromKit?.boomerang;
    if (!boomerang) throw new SettingsError("Boomerang is not deployed yet; set BOOMERANG_ADDRESS once it is");
    usdc = usdc ?? fromKit?.usdc;
    signedPledge = signedPledge ?? fromKit?.signedPledge ?? undefined;
    if (!usdc) throw new SettingsError("USDC_ADDRESS is not known; set it");
    rpcUrl = rpcFrom(env, { localOnly: false }) ?? arcTestnet.rpcUrls.default.http[0];
    chain = arcTestnet;
  }

  const portText = given(env, "PORT") ?? "8787";
  const port = Number(portText);
  if (!/^[0-9]{1,5}$/.test(portText) || port < 1 || port > 65535) throw new SettingsError("PORT is not a port number");
  // Reachable from this machine only unless told otherwise: a keeper put behind a proxy on the same
  // machine needs nothing more, and one that must be reached from outside says so (HOST=0.0.0.0).
  const host = given(env, "HOST") ?? "127.0.0.1";
  if (isIP(host) === 0) throw new SettingsError("HOST is not an IP address");

  return {
    secret,
    key: given(env, "KEEPER_PRIVATE_KEY") ?? null,
    chain,
    rpcUrl,
    local,
    boomerang,
    usdc,
    port,
    host,
    dataDir: given(env, "KEEPER_DATA") ?? "./data",
    demoRecipient: addressFrom(env, "DEMO_RECIPIENT") ?? null,
    signedPledge: signedPledge ?? null,
  };
}
