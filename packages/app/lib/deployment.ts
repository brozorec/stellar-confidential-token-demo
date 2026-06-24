/**
 * Deployment the app talks to. Mirror of deployments/testnet.json — update
 * after a redeploy.
 *
 * ⚠️ Demo-only exception: `auditorSecretHex` is the auditor's Grumpkin SECRET
 * key, published here so anyone can play the auditor persona on /auditor. In
 * any real deployment this never leaves the auditor's machine — only the
 * public key `K_aud = k·H` goes on-chain (auditor contract registry).
 */
import { Networks } from "@stellar/stellar-sdk";

export const DEPLOYMENT = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  /**
   * Optional Goldsky indexer (see packages/indexer/). When set, the app uses it
   * to backfill events older than the RPC's ~7-day retention window; when unset
   * the app runs RPC-only (events older than retention are unavailable). Read
   * at build time from NEXT_PUBLIC_INDEXER_URL.
   */
  indexerUrl: process.env.NEXT_PUBLIC_INDEXER_URL || undefined,
  /** Ledger the token was deployed at — the first-sync start point. */
  deployedAtLedger: 3013364,
  /** All accounts in this demo register under this auditor id. */
  auditorId: 0,
  /** Auditor Grumpkin secret `k` for auditor id 0 (see header warning). */
  auditorSecretHex: "0x00c066da47bac8f87cd3eb9a36c37b417ca40cfa2730e7d8eb7f0bf939d11832",
  contracts: {
    token: "CBF64DEOVQAXJFBSNGFEUT2AH4H7K5JBY3ZYJ5GVEINMNSDISWRG5N3F",
    verifier: "CDCET36PIS44DWJM5UQSSI4ZHGRDSBIIQW4G4ALPYK3Y6FEQGY5ZWFXL",
    auditor: "CA4II62E35TQKPGHCPBD6EBAS732GSGS6H37UUWKEDHR4YTBVMPHVY4L",
    underlying: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  },
} as const;
