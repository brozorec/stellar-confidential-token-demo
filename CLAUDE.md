# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A full-stack demo of a confidential token system on Stellar using Soroban smart contracts and client-side UltraHonk zero-knowledge proofs. Three components: Rust contracts, a TypeScript SDK, and a Next.js browser app.

## Commands

```bash
# Install dependencies
pnpm install

# Build contracts (Rust → WASM)
pnpm build:contracts

# Build SDK TypeScript → dist/
pnpm build:sdk

# Rebuild the disclosure circuit artifacts + VKs
pnpm build:disclosure

# Run all SDK tests (slow — includes proof generation ~15s)
pnpm test:sdk

# Run only fast tests (no proof generation) — sdk-scoped, no root alias
pnpm --filter @ctd/sdk test:fast

# Start dev server (auto-vendors bb.js via predev hook)
pnpm dev

# Deploy the demo to testnet: verifier, auditor, token, allowlist, blocklist,
# and the advanced-mode factory. Writes deployments/testnet.json.
pnpm deploy:contracts

# Full end-to-end workflow tests on testnet
pnpm e2e
pnpm e2e:disclosure
```

Tests are plain `.mjs` scripts run with `tsx`, not a test runner like Jest. `tsx`
is not on PATH — go through the workspace:
```bash
pnpm --filter @ctd/sdk exec tsx test/smoke.mjs
pnpm --filter @ctd/sdk exec tsx test/parity.mjs
pnpm --filter @ctd/sdk exec tsx test/payload.mjs
pnpm --filter @ctd/sdk exec tsx test/prove.mjs  # slow
```

`test/indexer-parity.mjs` and `test/shape-filter.mjs` hit a live indexer and
SKIP unless `CTD_INDEXER_URL` and `CTD_TOKEN` are both set.

After a redeploy, `deployments/testnet.json` is the only file the script
updates — `packages/app/lib/deployment.ts` (`DEFAULT_DEPLOYMENT`, including the
regenerated `auditorSecretHex`) and the README's deployment table are
hand-maintained copies.

## Architecture

### Monorepo layout

```
contracts/          # Soroban Rust workspace: token, token_with_compliance,
                    #   verifier, auditor, factory, policies/{allowlist,blocklist}
packages/sdk/       # @ctd/sdk — crypto, witness, proving, chain, state, auditor, disclosure
packages/app/       # @ctd/app — Next.js browser demo
packages/disclosure/# @ctd/disclosure — shared disclosure circuits + pinned VKs
                    #   (the trust anchor: prover AND verifier load these)
packages/indexer/   # @ctd/indexer — Goldsky pipeline + Cloudflare Worker read API
scripts/            # deploy.ts, e2e.ts, e2e-disclosure.ts, build-contracts.sh,
                    #   build-disclosure.mjs, vendor-bb.mjs, _shared.ts
deployments/        # Generated testnet.json (contract addresses, RPC URL)
```

### SDK layers (`packages/sdk/src/`)

1. **crypto/** — Grumpkin EC, Poseidon2 hash, key derivation. Keys are contract-bound: `vk = Poseidon2(VIEWING_KEY, sk, addr_f)` so keys from one deployment are useless on another.
2. **witness/** — Builds circuit inputs for `register`, `withdraw`, and `transfer`, plus the off-chain `disclose-recipient` / `disclose-sender` circuits.
3. **proving/** — `CircuitProver` calls bb.js `prove()` with witness bytes. Returns 14,592-byte UltraHonk proofs using keccak256 Fiat–Shamir transcripts (mandatory: the on-chain verifier is also keccak).
4. **chain/** — `ChainClient` wraps `@stellar/stellar-sdk`; submitters encode witness + proof as `Map<Symbol, ScVal>` XDR for contract args.
5. **state/** — `StateEngine` replays `getEvents` RPC responses to reconstruct `{v, r}` openings. Uses `LocalStorageStore` in the browser or `JsonFileStore` in Node. The store is load-bearing: receiving openings become unrecoverable after RPC event retention (~7 days on testnet) unless persisted locally.

### Contracts

- **token** — Main `ConfidentialToken`; operations: `register`, `deposit`, `merge`, `withdraw`, `confidential_transfer`.
- **verifier** — UltraHonk VK registry; `verify_proof(circuit_type, proof_bytes, public_inputs)` is the on-chain verifier.
- **auditor** — Grumpkin public key registry for dual-channel auditor ciphertexts (compliance decryption).
- **token_with_compliance** — The token plus an owner who can freeze/unfreeze accounts, optionally delegating to a policy contract.
- **policies/allowlist**, **policies/blocklist** — Standalone ownable membership policies the compliant token consults.
- **factory** — Holds the four child WASM hashes and deploys them, so advanced mode can deploy a token from the browser without uploading WASM.

### App (`packages/app/`)

- **lib/wallet.ts** — `ConfidentialWallet` orchestrates the SDK; manages prover cache and Freighter signing.
- **lib/bb-loader.ts** — Overrides SDK's default bb.js loader to load from `/vendor/bb/index.js` (native ESM, not bundled).
- **next.config.mjs** — Sets `COOP: same-origin` + `COEP: credentialless` headers (required for SharedArrayBuffer / Web Worker). Aliases `@aztec/bb.js` → `false` in the client webpack bundle.

## Critical: bb.js Must Never Be Webpack-Bundled

bb.js collides with webpack's module runtime and its Web Worker sibling files won't be found if chunked under `/_next/`. The fix is already in place:

1. `scripts/vendor-bb.mjs` (run by `predev`/`prebuild`) copies bb.js's browser bundle to `public/vendor/bb/` (git-ignored).
2. The webpack client config aliases `@aztec/bb.js` to `false`.
3. The app's bb-loader imports `/vendor/bb/index.js` as native ESM at runtime.

If you see a blank page or proving that hangs silently, the likely cause is bb.js being bundled.

## Cross-Origin Isolation

The app requires `window.crossOriginIsolated === true` for SharedArrayBuffer (used by bb.js's Web Worker). `COEP: credentialless` (not `require-corp`) is intentional — it allows the RPC fetch without needing CORS headers on the Stellar testnet endpoint.

## State Reconstruction Caveat

Testnet RPC retention is ~120,960 ledgers (~7 days). Receiving balance is a running sum of crediting events, so an opening whose event ages out before the client syncs is permanently lost — the chain stores commitments, not openings.

Two mitigations, both in `chain/event-source.ts` (`hybridFetchEvents`):
- The local store persists decrypted openings, re-checked against the on-chain commitments.
- An **optional** Goldsky indexer (`packages/indexer/`, enabled via `NEXT_PUBLIC_INDEXER_URL`) serves history older than the RPC window. It is consulted *only* when the requested start ledger predates the live retention floor; the indexer owns `[next, seam-1]` and RPC owns `[seam, head]`, disjoint by construction. A failed backfill deliberately fails the whole sync rather than letting the RPC leg's cursor persist and strand pre-window history forever.

With no indexer configured the client is RPC-only, and the local store becomes load-bearing: sync at least once per retention window.
