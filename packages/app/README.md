# @ctd/app — confidential-token demo front-end

The Next.js browser demo for the [confidential token](../../README.md). One page per persona:

- **`/wallet`** — connects Freighter, derives your confidential keys, and runs the five operations (register / deposit / merge / transfer / withdraw) with **proofs generated in the browser** (bb.js). Balances are reconstructed locally from chain events and shown with a "matches chain" badge (`StateEngine.verifyAgainstChain`).
- **`/verify`** — the disclosure receiver: mint a one-time request, verify the returned proof against the chain. No wallet needed.
- **`/auditor`** — decrypt transfer amounts with the registered auditor key.

The orchestration (prover cache, Freighter signing, the five ops) lives in `lib/wallet.ts` over [`@ctd/sdk`](../sdk/README.md).

## Run

```bash
pnpm build:sdk && pnpm dev   # http://localhost:3000
```

The confidential `sk` is derived deterministically from a Freighter `signMessage` signature over a deployment-bound message (Ed25519 signatures are deterministic, so the key is recoverable on any device and useless on other deployments), then cached in `localStorage` — a production wallet would store it encrypted.

## Event history & the indexer

Balances are reconstructed in the browser from chain events and persisted in `localStorage` (the SDK's `StateEngine` — see [State reconstruction & retention](../sdk/README.md#state-reconstruction--retention) for the mechanics and why local persistence is load-bearing). The Soroban RPC only retains ~7 days of history, so the app reads from a hybrid source: RPC for the recent tail, and an optional Goldsky indexer for older history.

Point the app at a deployed indexer to get full history:

```bash
# packages/app/.env.local
NEXT_PUBLIC_INDEXER_URL=https://confidential-token-indexer.<account>.workers.dev
```

Unset, the app runs **RPC-only**: events older than the ~7-day window are unavailable, so a fresh client must **sync at least once per retention period** or an aged-out incoming-transfer opening becomes unrecoverable. See [`@ctd/indexer`](../indexer/README.md) to deploy one.

## Cross-origin isolation

Browser proving needs `window.crossOriginIsolated === true` (SharedArrayBuffer, used by bb.js's Web Worker). The app sets `COOP: same-origin` + `COEP: credentialless` in `next.config.mjs`. `credentialless` (not `require-corp`) is intentional: it lets the RPC `fetch` through without needing CORS headers on the Stellar testnet endpoint.

## Deploy

The app deploys to **Cloudflare Workers** via `@opennextjs/cloudflare` (`pnpm deploy:app`, config in `wrangler.jsonc`). Next builds with the `--webpack` flag — the bb.js handling below is webpack-specific.

## Critical: bb.js must never be webpack-bundled

bb.js's pre-built browser bundle declares a top-level `__webpack_exports__` that collides with webpack's own module runtime, and it spawns its wasm Web Worker via `new Worker(new URL('./main.worker.js', import.meta.url))` (marked `webpackIgnore`) — so once bundled into a hashed `_next` chunk the worker can't be found and proving hangs forever (you'll see a blank page or a silent hang).

The fix is already in place:

1. `scripts/vendor-bb.mjs` (run by `predev`/`prebuild`) copies bb.js's `dest/browser/` into `public/vendor/bb/` (git-ignored, regenerated each build).
2. The webpack client config aliases the bare `@aztec/bb.js` specifier to `false`.
3. `lib/bb-loader.ts` overrides the SDK's `setUltraHonkBackendLoader` to import `/vendor/bb/index.js` as **native ESM** from that stable path at runtime. The loader's `new Function` must stay lazy — Cloudflare Workers forbid eval at the top level.
