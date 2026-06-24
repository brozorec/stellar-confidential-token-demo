# Confidential Token Demo (Stellar)

A working demo of a **confidential token on Stellar**: balances are Pedersen
commitments on the Grumpkin curve, and every state transition is proven with an
**UltraHonk zero-knowledge proof** verified on-chain. On top of the token sit
two compliance channels: **dual auditor ciphertexts** (a master-key auditor can
decrypt every transfer) and **off-chain selective disclosure** (a holder proves
one amount of one transfer to one designated receiver). Built on the
[OpenZeppelin `stellar-contracts`](https://github.com/OpenZeppelin/stellar-contracts)
`feat/confidential-verifier-ultrahonk` branch.

> ⚠️ **Not production ready.** The UltraHonk verifier backend and the circuits
> are unaudited. Testnet only; do not use with real value.

## What it does

Amounts and balances are never revealed on-chain. A balance is a commitment
`C = v·G + r·H`; the network only ever sees commitments and ZK proofs that the
arithmetic is correct (no overspend, conserved value, correct ownership).

Each account holds **two** balances:

- a **spendable** balance (what you can send/withdraw), and
- a **receiving** balance (where deposits and incoming transfers land).

`merge` folds receiving into spendable (a homomorphic point add — no proof).
Operations:

| Op | Proof? | Effect |
|----|--------|--------|
| `register` | ✔ | Bind your Grumpkin keys to the contract |
| `deposit` | — | Move public SEP-41 tokens → your receiving balance |
| `merge` | — | Fold receiving → spendable |
| `withdraw` | ✔ | Spendable → public SEP-41 tokens |
| `confidential_transfer` | ✔ | Spendable → another account's receiving |

Transfers also emit **dual auditor ciphertexts** (sender + recipient channels),
so a designated auditor holding the registered Grumpkin key can decrypt amounts
(`@ctd/sdk` ships the decryption side, and the app has an auditor console).

The demo is a three-hander — the app's landing page is a persona chooser:

- **Account holder** (`/wallet`) — connect Freighter, run the five operations
  with proofs generated in the browser.
- **Disclosure receiver** (`/verify`) — issue a one-time disclosure request,
  verify the returned proof against the chain. No wallet needed.
- **Auditor** (`/auditor`) — decrypt transfer amounts with the registered
  auditor key.

## Architecture

```
contracts/                    Rust/Soroban (separate Cargo workspace)
  token/                      ConfidentialToken (NoHooks) — the demo token
  verifier/                   UltraHonk VK registry (verify_proof)
  auditor/                    Grumpkin auditor-key registry
packages/
  sdk/        @ctd/sdk        crypto · witness · proving · chain · state · auditor · disclosure
  disclosure/ @ctd/disclosure shared disclosure circuits + pinned VKs (the off-chain trust anchor)
  app/        @ctd/app        Next.js demo front-end (Freighter wallet)
scripts/                      deploy.ts · e2e.ts · e2e-disclosure.ts  (testnet)
```

The SDK layers:

- **crypto** — Grumpkin (`@noble/curves`) and Poseidon2 (`@zkpassport/poseidon2`
  raw permutation), with generators, domain tags, and derivations matching the
  Noir `lib.nr` exactly. Validated by executing the real circuits (`noir_js`).
- **witness** — per-circuit input builders (register / withdraw / transfer),
  mirroring each circuit's public-input order.
- **proving** — UltraHonk via `bb.js` with a **keccak transcript** (mandatory:
  the on-chain verifier uses keccak256 Fiat–Shamir).
- **chain** — RPC client, the `{payload, proof}` XDR envelopes, op submitters,
  and event ingestion.
- **state** — RPC-only balance reconstruction with local persistence.
- **auditor** — decrypts the dual auditor ciphertexts emitted by transfers.
- **disclosure** — the off-chain selective-disclosure protocol: witness
  building + proving on the holder side, the full verifier protocol (event
  resolution via RPC, on-chain key lookup, VK pinning, decryption) on the
  receiver side.

## Selective disclosure (off-chain)

Beyond the always-on auditor channel, a holder can prove **one fact about one
on-chain event to one designated receiver**, without touching the contract.
Two circuit variants:

- **D-recipient** — *"this on-chain transfer paid me exactly X."*
- **D-sender** — *"I sent this on-chain transfer for exactly X, to account B."*
  The transfer's ephemeral randomness is re-derived deterministically from the
  sender's viewing key and the event's public `sigma`, so the wallet needs no
  extra bookkeeping to disclose past sends.

The flow: the receiver mints a one-time request (a fresh Grumpkin key + nonce)
→ the holder builds a witness from the **real chain event** and proves
client-side → the receiver resolves the referenced event via RPC, reads the
prover's registered public key from the chain, verifies the proof against a
**pinned VK**, and decrypts the amount. Stale or foreign nonces and references
to non-transfer events hard-reject.

`packages/disclosure` (`@ctd/disclosure`) holds the Noir circuits and their
pinned UltraHonk verification keys. Prover and receiver must agree on these
artifacts out-of-band — that agreement is the trust anchor of the off-chain
protocol. See its [README](packages/disclosure/README.md) for the file-by-file
breakdown; rebuild artifacts with `pnpm build:disclosure`.

## The central trade-off: RPC retention vs. indexer history

The protocol's spendable secrets (`v`, `r`) live **only in events** — the chain
stores commitments, not openings. The Soroban RPC `getEvents` API serves only
~7 days of history (testnet `ledgerRetentionWindow` ≈ 120 960 ledgers), so it
alone can't reconstruct older state.

The client reads events from a **hybrid source** (`chain/event-source.ts`):

- **RPC** for the recent tail — low latency, sees a just-submitted tx
  immediately.
- An optional **Goldsky indexer** (`packages/indexer/`) for the portion older
  than the RPC window — durable, full deployment history. The RPC always owns
  the tip; the indexer is queried only for the pre-window backfill, so warm
  syncs stay pure-RPC. Set `NEXT_PUBLIC_INDEXER_URL` to enable it; unset, the
  app runs RPC-only.

Consequences, handled deliberately:

- The state engine **persists decrypted openings locally** and tracks a sync
  cursor. With RPC alone, local persistence is *load-bearing for correctness*;
  with an indexer, a fresh client can also rebuild from full history.
- You **recover your spendable balance** from the most recent withdraw/transfer
  event's `b_tilde`+`sigma` alone (it encodes the resulting value), so a regular
  spender is robust within the window.
- The **receiving balance is a running sum**: with RPC only, if an
  incoming-transfer event ages out before you sync, that credit's opening is
  unrecoverable — so **sync at least once per retention period**. A configured
  indexer keeps those crediting events available indefinitely, lifting this
  limit (and giving the auditor and old-disclosure verification full history).

`StateEngine.verifyAgainstChain()` re-commits the local openings and checks them
against the on-chain commitments, so divergence is detected, never silently
spent.

## Deployed (testnet)

`deployments/testnet.json` (regenerate with `pnpm deploy:contracts`):

| Contract | ID |
|----------|----|
| token | `CBF64DEOVQAXJFBSNGFEUT2AH4H7K5JBY3ZYJ5GVEINMNSDISWRG5N3F` |
| verifier | `CDCET36PIS44DWJM5UQSSI4ZHGRDSBIIQW4G4ALPYK3Y6FEQGY5ZWFXL` |
| auditor | `CA4II62E35TQKPGHCPBD6EBAS732GSGS6H37UUWKEDHR4YTBVMPHVY4L` |
| underlying | native XLM SAC `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |

## Prerequisites

- Node ≥ 20, pnpm 10
- For rebuilding contracts: Rust stable + `wasm32v1-none`, `stellar` CLI ≥ 25.2.
  The OpenZeppelin crates are pulled as **git dependencies** from the
  `feat/confidential-verifier-ultrahonk` branch (pinned by `Cargo.lock`) — no
  local checkout needed.
- For regenerating circuit artifacts only: `nargo` 1.0.0-beta.9, `bb` 0.87.0,
  and a local checkout of `OpenZeppelin/stellar-contracts` @
  `feat/confidential-verifier-ultrahonk` at `../stellar-contracts-cv-ultrahonk`
  (the disclosure circuits' `Nargo.toml` path-depends on its Noir lib).

## Build & test

```bash
pnpm install
pnpm build:contracts        # stellar contract build → packages/sdk/contracts/*.wasm
pnpm build:sdk              # tsc → packages/sdk/dist
pnpm test:sdk               # full SDK suite (includes slow proof generation)

# Testnet (uses the `admin` stellar CLI identity as deployer):
pnpm deploy:contracts
pnpm e2e                    # register → deposit → merge → transfer → withdraw
pnpm e2e:disclosure         # disclosure proving + receiver verification over a real event

pnpm dev                    # run the Next.js demo app locally
pnpm deploy:app             # deploy the app to Cloudflare Workers (OpenNext)
pnpm build:disclosure       # recompile disclosure circuits + regenerate pinned VKs
```

### SDK test suite

The tests are the real correctness story:

- `test/parity.mjs` — builds each witness from SDK crypto and has the **actual
  circuit** (via `noir_js`) solve it; tamper cases must be rejected.
- `test/prove.mjs` — generates + verifies real UltraHonk proofs (keccak).
- `test/payload.mjs` — XDR envelope round-trip (Symbol-keyed contracttype maps,
  flat 64-byte points).
- `test/auditor.mjs` — auditor ciphertext decryption round-trip.
- `test/ephemeral.mjs` — deterministic ephemeral-randomness derivation for
  D-sender disclosures.
- `test/disclosure.mjs` — disclosure witnesses, proofs, and the receiver's
  verify protocol, including rejection paths (slow — real proofs).
- `test/smoke.mjs` — curve / Poseidon2 / serialization sanity.

### Web app (`@ctd/app`)

A Next.js app with one page per persona (see above): the **wallet** connects
Freighter, derives your confidential keys, and runs the five operations with
**proofs generated in the browser** (bb.js); balances are reconstructed locally
from RPC events and shown with a "matches chain" badge (`verifyAgainstChain`).
The **verify** page is the disclosure receiver; the **auditor** page decrypts
transfer amounts.

Browser proving needs cross-origin isolation (SharedArrayBuffer); the app sets
`COOP: same-origin` + `COEP: credentialless` in `next.config.mjs`. The
confidential `sk` is derived deterministically from a Freighter `signMessage`
signature over a deployment-bound message (Ed25519 signatures are
deterministic, so the key is recoverable on any device and useless on other
deployments), then cached in `localStorage` — a production wallet would store
it encrypted.

```bash
pnpm build:sdk && pnpm dev   # http://localhost:3000
```

The app deploys to **Cloudflare Workers** via `@opennextjs/cloudflare`
(`pnpm deploy:app`, config in `wrangler.jsonc`). Next builds with the
`--webpack` flag — the bb.js handling below is webpack-specific.

**bb.js is *not* bundled by webpack.** Its pre-built browser bundle declares a
top-level `__webpack_exports__` that collides with webpack's own module runtime,
and it spawns its wasm Web Worker via
`new Worker(new URL('./main.worker.js', import.meta.url))` (marked
`webpackIgnore`) — so once bundled into a hashed `_next` chunk the worker can't
be found and proving hangs forever. Instead, `scripts/vendor-bb.mjs` copies
bb.js's `dest/browser/` into `public/vendor/bb/` (run automatically by the app's
`predev`/`prebuild`), the SDK prover loads it as **native ESM** from that stable
path (`lib/bb-loader.ts` overrides `setUltraHonkBackendLoader`), and the bare
`@aztec/bb.js` specifier is aliased away in the client webpack config. The
vendored copy is git-ignored and regenerated from `node_modules` on each build.

## License

MIT.
