/**
 * Deploy the confidential-token demo to Stellar testnet:
 *
 *   1. Ensure the native XLM Stellar Asset Contract exists (the underlying
 *      SEP-41 — chosen because it needs no minting or trustlines).
 *   2. Deploy verifier + auditor + token (constructor wires them together).
 *   3. Register all six circuit verification keys in the verifier.
 *   4. Register one auditor Grumpkin key (id 0).
 *   5. Assert the contract's stored address-as-field equals the SDK's
 *      `addressToField(token)` — the Poseidon2 parity guard.
 *   6. Write deployments/testnet.json.
 *
 * Usage: pnpm --filter @ctd/sdk exec tsx ../../scripts/deploy.ts
 * Deployer identity: the `admin` key in the stellar CLI config.
 */

import { xdr, Address } from "@stellar/stellar-sdk";

import {
  NETWORK, RPC_URL, PASSPHRASE, WASM, REPO_ROOT,
  stellar, stellarSoft, publicKey, secret, readVk, saveDeployment, type Deployment,
} from "./_shared.js";
import { ChainClient, keypairSigner } from "../packages/sdk/src/chain/client.js";
import { addressToField } from "../packages/sdk/src/crypto/address.js";
import { randomScalar, toHex32, fromBytesBE } from "../packages/sdk/src/crypto/field.js";
import { H, scalarMul, pointToBytes, pointCoords } from "../packages/sdk/src/crypto/grumpkin.js";
import { CIRCUIT_TYPE } from "../packages/sdk/src/crypto/constants.js";

const DEPLOYER = "admin";

// vk.bin filename → CircuitType discriminant.
const VK_FILES: ReadonlyArray<[string, number]> = [
  ["register", CIRCUIT_TYPE.Register],
  ["withdraw", CIRCUIT_TYPE.Withdraw],
  ["transfer", CIRCUIT_TYPE.Transfer],
  ["spender_transfer", CIRCUIT_TYPE.SpenderTransfer],
  ["set_spender", CIRCUIT_TYPE.SetSpender],
  ["revoke_spender", CIRCUIT_TYPE.RevokeSpender],
];

function deploy(wasmPath: string, ctorArgs: string[]): string {
  const out = stellar([
    "contract", "deploy",
    "--wasm", wasmPath,
    "--source", DEPLOYER,
    "--network", NETWORK,
    "--optimize=false",
    "--", ...ctorArgs,
  ]);
  // The contract id is the last non-empty line of stdout.
  const id = out.split(/\s+/).filter(Boolean).pop()!;
  if (!id.startsWith("C")) throw new Error(`unexpected deploy output: ${out}`);
  return id;
}

async function main(): Promise<void> {
  const deployerPub = publicKey(DEPLOYER);
  console.log(`deployer ${DEPLOYER} = ${deployerPub}`);

  // 1. Native XLM SAC as the underlying asset.
  stellarSoft(["contract", "asset", "deploy", "--asset", "native", "--source", DEPLOYER, "--network", NETWORK]);
  const underlying = stellar(["contract", "id", "asset", "--asset", "native", "--network", NETWORK]);
  console.log(`underlying (native SAC) = ${underlying}`);

  // 2. Deploy registries + token.
  const verifier = deploy(WASM.verifier, ["--admin", deployerPub, "--manager", deployerPub]);
  console.log(`verifier = ${verifier}`);
  const auditor = deploy(WASM.auditor, ["--admin", deployerPub, "--manager", deployerPub]);
  console.log(`auditor = ${auditor}`);

  // Standalone ownable compliance policies. Independent of the token wiring and
  // the addr_f parity guard; owner = deployer (only the owner can mutate).
  const allowlist = deploy(WASM.allowlist, ["--owner", deployerPub]);
  console.log(`allowlist = ${allowlist}`);
  const blocklist = deploy(WASM.blocklist, ["--owner", deployerPub]);
  console.log(`blocklist = ${blocklist}`);

  const client = new ChainClient({
    rpcUrl: RPC_URL,
    networkPassphrase: PASSPHRASE,
    contracts: { token: "", verifier, auditor },
  });
  const ledgerBeforeToken = await client.latestLedger();

  const token = deploy(WASM.token, [
    "--underlying_asset", underlying,
    "--verifier", verifier,
    "--auditor", auditor,
  ]);
  console.log(`token = ${token}`);
  client.cfg.contracts.token = token;

  const signer = keypairSigner(secret(DEPLOYER), PASSPHRASE);

  // 3. Register the six verification keys.
  for (const [name, circuitType] of VK_FILES) {
    const vk = readVk(name);
    await client.invoke(
      verifier,
      "register_verification_key",
      [
        xdr.ScVal.scvU32(circuitType),
        xdr.ScVal.scvBytes(Buffer.from(vk)),
        new Address(deployerPub).toScVal(),
      ],
      signer,
    );
    console.log(`  registered VK ${name} (circuit ${circuitType}, ${vk.length}B)`);
  }

  // 4. Register one auditor key (id 0). K_aud = a·H for a random scalar a.
  const auditorSecret = randomScalar();
  const kAud = scalarMul(auditorSecret, H);
  await client.invoke(
    auditor,
    "register_key",
    [
      xdr.ScVal.scvU32(0),
      xdr.ScVal.scvBytes(Buffer.from(pointToBytes(kAud))),
      new Address(deployerPub).toScVal(),
    ],
    signer,
  );
  const kAudCoords = pointCoords(kAud);
  console.log(`  registered auditor key id 0`);

  // 5. addr_f parity: compare the contract's emitted AddressAsField to the SDK.
  const sdkAddrF = addressToField(token);
  const onchainAddrF = await readAddressAsField(client, ledgerBeforeToken);
  if (onchainAddrF === null) {
    console.warn("  ! could not find AddressAsFieldSet event; skipping parity assert");
  } else if (onchainAddrF !== sdkAddrF) {
    throw new Error(
      `addr_f MISMATCH — SDK ${toHex32(sdkAddrF)} != contract ${toHex32(onchainAddrF)}. ` +
        `Poseidon2 implementations diverge; register proofs would fail.`,
    );
  } else {
    console.log(`  addr_f parity OK: ${toHex32(sdkAddrF)}`);
  }

  const deployment: Deployment = {
    network: NETWORK,
    rpcUrl: RPC_URL,
    passphrase: PASSPHRASE,
    deployedAtLedger: ledgerBeforeToken,
    contracts: { token, verifier, auditor, underlying, allowlist, blocklist },
    auditor: {
      id: 0,
      secretHex: toHex32(auditorSecret),
      keyXHex: toHex32(kAudCoords.x),
      keyYHex: toHex32(kAudCoords.y),
    },
    addrF: toHex32(sdkAddrF),
  };
  saveDeployment(deployment);
  console.log(`\nwrote deployments/${NETWORK}.json`);
}

/** Scan token events for `address_as_field_set` and return its field value. */
async function readAddressAsField(client: ChainClient, fromLedger: number): Promise<bigint | null> {
  // Raw scan (the typed fetchEvents skips config events). One page suffices:
  // the setter event fires during construction, right after fromLedger.
  const resp = await client.server.getEvents({
    startLedger: fromLedger,
    filters: [{ type: "contract", contractIds: [client.cfg.contracts.token] }],
    limit: 50,
  });
  for (const ev of resp.events) {
    if (ev.topic[0]?.sym().toString() !== "address_as_field_set") continue;
    for (const entry of ev.value.map() ?? []) {
      if (entry.key().sym().toString() === "address_as_field") {
        return fromBytesBE(new Uint8Array(entry.val().bytes()));
      }
    }
  }
  return null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
