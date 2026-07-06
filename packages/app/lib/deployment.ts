/**
 * Deployments the app can serve.
 *
 * The app always knows the built-in {@link DEFAULT_DEPLOYMENT} (the canonical
 * vanilla token from deployments/testnet.json). In "advanced mode" the user
 * deploys their own confidential token via the shared factory and the app
 * serves that deployment instead — see lib/active-deployment.tsx, which tracks
 * which one is active and persists the advanced one in localStorage.
 *
 * The verifier and auditor are CONSTANT across deployments (a factory-deployed
 * token is wired to the same registries), so the auditor key fields below are
 * shared by every deployment.
 *
 * ⚠️ Demo-only exception: `auditorSecretHex` is the auditor's Grumpkin SECRET
 * key, published here so anyone can play the auditor persona on /auditor. In
 * any real deployment this never leaves the auditor's machine — only the
 * public key `K_aud = k·H` goes on-chain (auditor contract registry).
 */
import { Networks } from "@stellar/stellar-sdk";

/** Which confidential-token configuration a deployment uses. */
export type CtKind = "vanilla" | "compliance" | "allowlist" | "blocklist";

export interface DeploymentContracts {
  token: string;
  verifier: string;
  auditor: string;
  underlying: string;
  /**
   * Shared token factory the advanced-mode wizard invokes. Empty until
   * `scripts/deploy.ts` has provisioned it and its id is pasted in below.
   */
  factory: string;
  /** Policy contract — present only for `allowlist` / `blocklist` kinds. */
  policy?: string;
}

export interface Deployment {
  /** Stable id; `"default"` for the built-in deployment, `"advanced"` otherwise. */
  id: string;
  /** Short human label shown in the deployment selector. */
  label: string;
  kind: CtKind;
  rpcUrl: string;
  networkPassphrase: string;
  /**
   * Goldsky indexer base URL (full-history event source). Read at build time
   * from NEXT_PUBLIC_INDEXER_URL; constant across deployments.
   */
  indexerUrl?: string;
  /** Ledger the token was deployed at — the first-sync start point. */
  deployedAtLedger: number;
  /** Every account in this demo registers under this auditor id. */
  auditorId: number;
  /** Auditor Grumpkin secret `k` (see header warning). */
  auditorSecretHex: string;
  contracts: DeploymentContracts;
  /**
   * Token owner / admin (G-address). Set for compliant deployments created in
   * advanced mode (the deployer becomes the owner). Absent for vanilla (no
   * owner) and for the built-in default.
   */
  owner?: string;
}

const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || undefined;

export const DEFAULT_DEPLOYMENT: Deployment = {
  id: "default",
  label: "Default Confidential Token",
  kind: "vanilla",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  indexerUrl: INDEXER_URL,
  deployedAtLedger: 3013364,
  auditorId: 0,
  auditorSecretHex: "0x00c066da47bac8f87cd3eb9a36c37b417ca40cfa2730e7d8eb7f0bf939d11832",
  contracts: {
    token: "CBF64DEOVQAXJFBSNGFEUT2AH4H7K5JBY3ZYJ5GVEINMNSDISWRG5N3F",
    verifier: "CDCET36PIS44DWJM5UQSSI4ZHGRDSBIIQW4G4ALPYK3Y6FEQGY5ZWFXL",
    auditor: "CA4II62E35TQKPGHCPBD6EBAS732GSGS6H37UUWKEDHR4YTBVMPHVY4L",
    underlying: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    // ⚠️ Paste the factory id printed by `scripts/deploy.ts` here. Advanced
    // mode is disabled in the UI until this is set.
    factory: "CDX4DBNWDMD7BVZCOJPTXVTBRXU2RG7JUOZKOOUX5RVWWWWIGV2LWS6Z",
  },
};

/** The XLM Stellar Asset Contract — the default underlying for advanced mode. */
export const XLM_SAC = DEFAULT_DEPLOYMENT.contracts.underlying;

/** Human label for a CT kind (used across the advanced wizard + admin UI). */
export function kindLabel(kind: CtKind): string {
  switch (kind) {
    case "vanilla":
      return "Default Confidential Token";
    case "compliance":
      return "Confidential Token with compliance (freeze only)";
    case "allowlist":
      return "Confidential Token with compliance + allowlist policy";
    case "blocklist":
      return "Confidential Token with compliance + blocklist policy";
  }
}

/**
 * Whether a deployment exposes the Token Admin dashboard. True for compliant
 * kinds (owner-gated compliance management) and also for a vanilla token
 * deployed in advanced mode — it has no owner or compliance to manage, but the
 * dashboard is the only place to redeploy, so it must stay reachable. The
 * built-in default is excluded either way: nothing to manage, nothing to
 * redeploy.
 */
export function hasAdminDashboard(deployment: Pick<Deployment, "id">): boolean {
  return deployment.id !== "default";
}
