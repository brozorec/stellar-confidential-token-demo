/**
 * Shared helpers for the deploy / e2e scripts. Targets Stellar testnet via the
 * `stellar` CLI (for deploys + key storage) and the SDK (for invokes + crypto).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Networks } from "@stellar/stellar-sdk";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const NETWORK = "testnet";
export const RPC_URL = "https://soroban-testnet.stellar.org";
export const PASSPHRASE = Networks.TESTNET;
export const FRIENDBOT = "https://friendbot.stellar.org";

export const WASM = {
  token: join(REPO_ROOT, "packages/sdk/contracts/confidential_token.wasm"),
  tokenWithCompliance: join(REPO_ROOT, "packages/sdk/contracts/token_with_compliance.wasm"),
  verifier: join(REPO_ROOT, "packages/sdk/contracts/confidential_verifier.wasm"),
  auditor: join(REPO_ROOT, "packages/sdk/contracts/confidential_auditor.wasm"),
  allowlist: join(REPO_ROOT, "packages/sdk/contracts/allowlist.wasm"),
  blocklist: join(REPO_ROOT, "packages/sdk/contracts/blocklist.wasm"),
  factory: join(REPO_ROOT, "packages/sdk/contracts/token_factory.wasm"),
};

export const VKS_DIR = join(REPO_ROOT, "packages/sdk/circuits/vks");
export const DEPLOYMENTS = join(REPO_ROOT, "deployments", `${NETWORK}.json`);

export interface Deployment {
  network: string;
  rpcUrl: string;
  passphrase: string;
  deployedAtLedger: number;
  contracts: {
    token: string;
    verifier: string;
    auditor: string;
    underlying: string;
    // Standalone ownable compliance policies (owner = deployer). Optional so
    // deployments predating these contracts still parse.
    allowlist?: string;
    blocklist?: string;
  };
  auditor: { id: number; secretHex: string; keyXHex: string; keyYHex: string };
  addrF: string;
}

/** Run the `stellar` CLI, returning trimmed stdout (throws on non-zero exit). */
export function stellar(args: string[]): string {
  return execFileSync("stellar", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Like {@link stellar} but tolerates failure (e.g. "asset already deployed"). */
export function stellarSoft(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: stellar(args) };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    return { ok: false, out: (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? err.message ?? "") };
  }
}

/** Public key for a stored CLI identity. */
export function publicKey(name: string): string {
  return stellar(["keys", "public-key", name]);
}

/** Secret key for a stored CLI identity (testnet demo keys only). */
export function secret(name: string): string {
  return stellar(["keys", "show", name]);
}

/** Fund a G-address via friendbot (no-op if already funded). */
export async function friendbotFund(pubkey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pubkey)}`);
  if (!res.ok && res.status !== 400) {
    throw new Error(`friendbot failed for ${pubkey}: ${res.status}`);
  }
}

export function loadDeployment(): Deployment {
  if (!existsSync(DEPLOYMENTS)) {
    throw new Error(`no deployment at ${DEPLOYMENTS}; run deploy first`);
  }
  return JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) as Deployment;
}

export function saveDeployment(d: Deployment): void {
  mkdirSync(dirname(DEPLOYMENTS), { recursive: true });
  writeFileSync(DEPLOYMENTS, JSON.stringify(d, null, 2));
}

export function readVk(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(VKS_DIR, `${name}.vk.bin`)));
}
