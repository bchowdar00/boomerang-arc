// Every token, key and address in these tests is invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { settingsFrom, SettingsError } from "../src/settings.ts";
import type { Address } from "../../../packages/kit/src/index.ts";

const B = "0x00000000000000000000000000000000000000b0" as Address;
const U = "0x3600000000000000000000000000000000000000" as Address;
const R = "0x00000000000000000000000000000000000000c0";
const deployed = () => ({ boomerang: B, usdc: U });
const none = () => {
  throw new Error("not deployed");
};
const base = { STREAM_SECURITY_TOKEN: "token-invented" };

describe("the keeper's settings", function () {
  it("settings.arc: with only a token, the keeper watches Arc Testnet at the deployed addresses", function () {
    const s = settingsFrom(base, deployed);
    assert.equal(s.chain.id, 5042002);
    assert.equal(s.local, false);
    assert.equal(s.rpcUrl, "https://rpc.testnet.arc.io");
    assert.deepEqual([s.boomerang, s.usdc, s.port, s.dataDir, s.key, s.demoRecipient], [B, U, 8787, "./data", null, null]);
    // It listens on this machine only until HOST names another address.
    assert.equal(s.host, "127.0.0.1");
    assert.equal(settingsFrom({ ...base, HOST: "0.0.0.0" }, deployed).host, "0.0.0.0");
    assert.equal(settingsFrom({ ...base, HOST: "::1" }, deployed).host, "::1");
    // Each can be set; an empty value is the same as none.
    const set = settingsFrom({ ...base, RPC_URL: "https://example.quiknode.pro/abc/", PORT: "9000", KEEPER_DATA: "/var/keeper", KEEPER_PRIVATE_KEY: "0xkey", DEMO_RECIPIENT: R, CHAIN_ID: "5042002", USDC_ADDRESS: "" }, deployed);
    assert.deepEqual([set.rpcUrl, set.port, set.dataDir, set.key, set.demoRecipient, set.local, set.usdc], ["https://example.quiknode.pro/abc/", 9000, "/var/keeper", "0xkey", R, false, U]);
  });

  it("settings.refuses: each wrong value stops the keeper with that value's name, and no value's text", function () {
    const cases: [Record<string, string>, RegExp][] = [
      [{ STREAM_SECURITY_TOKEN: "" }, /^STREAM_SECURITY_TOKEN is required$/],
      [{ BOOMERANG_ADDRESS: "0x12" }, /^BOOMERANG_ADDRESS is not an address$/],
      [{ USDC_ADDRESS: "usdc" }, /^USDC_ADDRESS is not an address$/],
      [{ DEMO_RECIPIENT: "me" }, /^DEMO_RECIPIENT is not an address$/],
      [{ PORT: "0" }, /^PORT is not a port number$/],
      [{ PORT: "70000" }, /^PORT is not a port number$/],
      [{ PORT: "80a" }, /^PORT is not a port number$/],
      [{ HOST: "keeper.example secret-part" }, /^HOST is not an IP address$/],
      [{ CHAIN_ID: "arc" }, /^CHAIN_ID is not a chain id$/],
      [{ CHAIN_ID: "-1" }, /^CHAIN_ID is not a chain id$/],
      [{ RPC_URL: "not a url secret-part" }, /^RPC_URL is not a URL$/],
      [{ RPC_URL: "http://rpc.example/secret-part" }, /^RPC_URL must be https/],
      [{ RPC_URL: "ftp://127.0.0.1/secret-part" }, /^RPC_URL must be https/],
    ];
    for (const [over, want] of cases) {
      assert.throws(
        () => settingsFrom({ ...base, ...over }, deployed),
        (e: unknown) => e instanceof SettingsError && want.test(e.message) && !e.message.includes("secret-part") && !e.message.includes("token-invented"),
        JSON.stringify(over),
      );
    }
    // Before a deployment there is no address to fall back on.
    assert.throws(() => settingsFrom(base, none), /Boomerang is not deployed yet/);
    assert.throws(() => settingsFrom({ ...base, BOOMERANG_ADDRESS: B }, none), /USDC_ADDRESS is not known/);
    assert.equal(settingsFrom({ ...base, BOOMERANG_ADDRESS: B, USDC_ADDRESS: U }, none).boomerang, B);
  });

  it("settings.signedPledge: the relay's helper comes from SIGNED_PLEDGE_ADDRESS, else from the deployment on Arc, else none", function () {
    const H = "0x00000000000000000000000000000000000000d0";
    assert.equal(settingsFrom(base, deployed).signedPledge, null);
    assert.equal(settingsFrom(base, () => ({ boomerang: B, usdc: U, signedPledge: H as Address })).signedPledge, H);
    assert.equal(settingsFrom({ ...base, SIGNED_PLEDGE_ADDRESS: R }, () => ({ boomerang: B, usdc: U, signedPledge: H as Address })).signedPledge, R);
    const local = { ...base, CHAIN_ID: "31337", RPC_URL: "http://127.0.0.1:8545", BOOMERANG_ADDRESS: B, USDC_ADDRESS: U };
    assert.equal(settingsFrom(local, () => ({ boomerang: B, usdc: U, signedPledge: H as Address })).signedPledge, null);
    assert.equal(settingsFrom({ ...local, SIGNED_PLEDGE_ADDRESS: H }, deployed).signedPledge, H);
    assert.throws(() => settingsFrom({ ...base, SIGNED_PLEDGE_ADDRESS: "0x12" }, deployed), SettingsError);
  });

  it("settings.local: another chain id is taken only for a node on this machine, with both addresses given", function () {
    const local = { ...base, CHAIN_ID: "31337", RPC_URL: "http://127.0.0.1:8545", BOOMERANG_ADDRESS: B, USDC_ADDRESS: U };
    const s = settingsFrom(local, deployed);
    assert.deepEqual([s.chain.id, s.local, s.rpcUrl, s.boomerang, s.usdc], [31337, true, "http://127.0.0.1:8545", B, U]);
    assert.equal(settingsFrom({ ...local, RPC_URL: "http://localhost:8545" }, deployed).local, true);
    assert.equal(settingsFrom({ ...local, RPC_URL: "http://[::1]:8545" }, deployed).local, true);
    // A local chain id never takes the deployed addresses, and never an RPC somewhere else.
    for (const [over, want] of [
      [{ RPC_URL: "https://rpc.testnet.arc.io" }, /RPC_URL must be on this machine/],
      [{ RPC_URL: "http://127.0.0.1.example.com:8545" }, /RPC_URL must be on this machine/],
      [{ RPC_URL: "http://localhost@rpc.example:8545" }, /RPC_URL must be on this machine/],
      [{ RPC_URL: "http://0.0.0.0:8545" }, /RPC_URL must be on this machine/],
      [{ RPC_URL: "http://192.168.1.10:8545" }, /RPC_URL must be on this machine/],
      [{ RPC_URL: "" }, /RPC_URL is required/],
      [{ BOOMERANG_ADDRESS: "" }, /BOOMERANG_ADDRESS is required/],
      [{ USDC_ADDRESS: "" }, /USDC_ADDRESS is required/],
    ] as const) {
      assert.throws(() => settingsFrom({ ...local, ...over }, deployed), want, JSON.stringify(over));
    }
    // And Arc's own id never takes plain http from another host.
    assert.throws(() => settingsFrom({ ...base, RPC_URL: "http://rpc.example" }, deployed), /must be https/);
    assert.equal(settingsFrom({ ...base, RPC_URL: "http://127.0.0.1:8545" }, deployed).local, false);
  });
});
