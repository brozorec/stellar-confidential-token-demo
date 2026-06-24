# @ctd/sdk — confidential-token client SDK

The TypeScript client for the [confidential token demo](../../README.md): it builds witnesses, generates and verifies UltraHonk proofs, talks to the Soroban contracts, reconstructs balances from chain events, and implements both compliance channels (auditor decryption and off-chain selective disclosure).

The SDK's crypto is the off-chain mirror of the on-chain Noir circuits — every generator, domain tag, and derivation matches `lib.nr` exactly, validated by executing the real circuits in the test suite.

## Layers (`src/`)

- **crypto** — Grumpkin (`@noble/curves`) and Poseidon2 (`@zkpassport/poseidon2` raw permutation), with generators, domain tags, and derivations matching the Noir `lib.nr` exactly. Validated by executing the real circuits (`noir_js`).
- **witness** — per-circuit input builders (register / withdraw / transfer), mirroring each circuit's public-input order.
- **proving** — UltraHonk via `bb.js` with a **keccak transcript** (mandatory: the on-chain verifier uses keccak256 Fiat–Shamir).
- **chain** — RPC client, the `{payload, proof}` XDR envelopes, op submitters, and event ingestion (`chain/event-source.ts` is the hybrid RPC + indexer source — see [State reconstruction & retention](#state-reconstruction--retention)).
- **state** — balance reconstruction from chain events with local persistence and an on-chain consistency check (see [State reconstruction & retention](#state-reconstruction--retention)).
- **auditor** — decrypts the dual auditor ciphertexts emitted by transfers.
- **disclosure** — the off-chain selective-disclosure protocol: witness building + proving on the holder side, the full verifier protocol (event resolution via RPC, on-chain key lookup, VK pinning, decryption) on the receiver side. The shared circuits + pinned VKs live in [`@ctd/disclosure`](../disclosure/README.md).

## State reconstruction & retention

The protocol's spendable secrets (`v`, `r`) live **only in events** — the chain stores commitments, not openings. The Soroban RPC `getEvents` API serves only ~7 days of history (testnet `ledgerRetentionWindow` ≈ 120 960 ledgers), so it alone can't reconstruct older state.

The `chain` layer reads events from a **hybrid source** (`chain/event-source.ts`):

- **RPC** for the recent tail — low latency, sees a just-submitted tx immediately.
- An optional **Goldsky indexer** ([`@ctd/indexer`](../indexer/README.md)) for the portion older than the RPC window — durable, full deployment history. The RPC always owns the tip; the indexer is queried only for the pre-window backfill, so warm syncs stay pure-RPC. The app enables it via `NEXT_PUBLIC_INDEXER_URL` (see [`@ctd/app`](../app/README.md#event-history--the-indexer)); unset, it runs RPC-only.

The `state` layer's `StateEngine` reconstructs `{v, r}` openings from that source, with consequences handled deliberately:

- It **persists decrypted openings locally** and tracks a sync cursor. With RPC alone, local persistence is *load-bearing for correctness*; with an indexer, a fresh client can also rebuild from full history.
- You **recover your spendable balance** from the most recent withdraw/transfer event's `b_tilde`+`sigma` alone (it encodes the resulting value), so a regular spender is robust within the window.
- The **receiving balance is a running sum**: with RPC only, if an incoming-transfer event ages out before you sync, that credit's opening is unrecoverable — so **sync at least once per retention period**. A configured indexer keeps those crediting events available indefinitely, lifting this limit (and giving the auditor and old-disclosure verification full history).

`StateEngine.verifyAgainstChain()` re-commits the local openings and checks them against the on-chain commitments, so divergence is detected, never silently spent.

## Build & test

```bash
pnpm build:sdk              # tsc → packages/sdk/dist
pnpm test:sdk               # full suite (includes slow proof generation)
```

The tests are plain `.mjs` scripts run with `tsx`, not a test runner. Run one individually with `pnpm --filter @ctd/sdk exec tsx test/<name>.mjs`.

### Test suite

The tests are the real correctness story:

- `test/parity.mjs` — builds each witness from SDK crypto and has the **actual circuit** (via `noir_js`) solve it; tamper cases must be rejected.
- `test/prove.mjs` — generates + verifies real UltraHonk proofs (keccak).
- `test/payload.mjs` — XDR envelope round-trip (Symbol-keyed contracttype maps, flat 64-byte points).
- `test/auditor.mjs` — auditor ciphertext decryption round-trip.
- `test/ephemeral.mjs` — deterministic ephemeral-randomness derivation for D-sender disclosures.
- `test/disclosure.mjs` — disclosure witnesses, proofs, and the receiver's verify protocol, including rejection paths (slow — real proofs).
- `test/smoke.mjs` — curve / Poseidon2 / serialization sanity.
- `test/indexer-parity.mjs` — pins the indexer decoder against RPC-decoded events (needs a deployed indexer; see [`@ctd/indexer`](../indexer/README.md)).
