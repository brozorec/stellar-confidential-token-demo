# Confidential Token Demo (Stellar)

A working demo of a **confidential token on Stellar**: balances are Pedersen commitments on the Grumpkin curve, and every state transition is proven with an UltraHonk zero-knowledge proof verified on-chain. On top of the token sit two compliance channels: **dual auditor** ciphertexts (a master-key auditor can decrypt every transfer) and off-chain **selective disclosure** (a holder proves one amount of one transfer to one designated receiver). Built on the [OpenZeppelin `stellar-contracts`](https://github.com/OpenZeppelin/stellar-contracts) `feat/confidential-verifier-ultrahonk` branch.

> ⚠️ **Not production ready.** The UltraHonk verifier backend and the circuits are unaudited. Testnet only; do not use with real value.

## What it does

Amounts and balances are never revealed on-chain. A balance is a commitment `C = v·G + r·H`; the network only ever sees commitments and ZK proofs that the arithmetic is correct (no overspend, conserved value, correct ownership).

Each account holds two balances:

- a **spendable** balance (what you can send/withdraw), and
- a **receiving** balance (where deposits and incoming transfers land).

`merge` folds receiving into spendable (a homomorphic point add). Operations:

| Op | Proof? | Effect |
|----|--------|--------|
| `register` | ✔ | Bind your Grumpkin keys to the contract |
| `deposit` | — | Move public SEP-41 tokens → your receiving balance |
| `merge` | — | Fold receiving → spendable |
| `withdraw` | ✔ | Spendable → public SEP-41 tokens |
| `confidential_transfer` | ✔ | Spendable → another account's receiving |

Transfers also emit dual auditor ciphertexts (sender + recipient channels), so a designated auditor holding the registered Grumpkin key can decrypt amounts (`@ctd/sdk` ships the decryption side, and the app has an auditor console).

The demo is a three-hander — the app's landing page is a persona chooser:

- **Account holder** (`/wallet`) — connect Freighter, run the five operations with proofs generated in the browser.
- **Disclosure receiver** (`/verify`) — issue a one-time disclosure request, verify the returned proof against the chain. No wallet needed.
- **Auditor** (`/auditor`) — decrypt transfer amounts with the registered auditor key.

## Getting started

### Basic

The fastest way to get a feel for confidential tokens is to make a private transfer on testnet. The contracts are already deployed on testnet. (see [Deployed](#deployed-testnet)).

Options:

**A.** Open the [live demo](https://stellar-confidential-token-demo.billowing-moon-0c6f.workers.dev/), install the [Freighter](https://freighter.app/) browser wallet, switch it to **Testnet**, and fund your account with test XLM (Freighter's built-in Friendbot button, or [Stellar Lab → Fund account](https://lab.stellar.org/account/fund)).

**B.** Clone and run locally (see [Prerequisites](#prerequisites)):
```bash
git clone https://github.com/brozorec/stellar-confidential-token-demo
cd stellar-confidential-token-demo
pnpm install
pnpm build:sdk
pnpm dev                     # http://localhost:3000
```

Either way, the app opens on the persona chooser. As the **account holder** (`/wallet`), proofs are generated in the browser (~1s each):

1. **Connect Freighter**, then **Register** — derives your confidential keys and binds them to the contract.
2. **Deposit** — move public XLM into your *receiving* balance.
3. **Merge** — fold the receiving balance into your *spendable* balance.
4. **Transfer** — send to another registered account's receiving balance.
5. **Withdraw** — convert spendable back to public XLM.

Then try the other two personas: **/verify** (a disclosure receiver verifies that one transfer paid them exactly X) and **/auditor** (decrypt transfer amounts with the registered auditor key).

### Advanced

To compile the contracts, run the proof/parity suites, deploy your own contracts, or drive the whole flow from scripts:

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
pnpm build:disclosure       # recompile disclosure circuits + regenerate pinned VKs
```

This demo wraps the protocol end to end; the protocol itself lives in [OpenZeppelin `stellar-contracts`](https://github.com/OpenZeppelin/stellar-contracts/tree/feat/confidential-verifier-ultrahonk), which `contracts/` consume as git dependencies.

- [Confidential token module](https://github.com/OpenZeppelin/stellar-contracts/tree/feat/confidential-verifier-ultrahonk/packages/tokens/src/confidential): the on-chain logic for `register` / `deposit` / `merge` / `withdraw` / `confidential_transfer`.
- [Noir circuits](https://github.com/OpenZeppelin/stellar-contracts/tree/feat/confidential-verifier-ultrahonk/packages/tokens/src/confidential/circuits): the register / withdraw / transfer circuits and the shared `lib` whose generators, hashes, and derivations `@ctd/sdk`'s crypto mirrors exactly.
- [UltraHonk verifier](https://github.com/NethermindEth/rs-soroban-ultrahonk): the proof-verification backend the verifier contract runs (maintained by Nethermind).

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
  indexer/    @ctd/indexer    Goldsky indexer to ingest events and a handler API to read stored events
scripts/                      deploy.ts · e2e.ts · e2e-disclosure.ts  (testnet)
```

Each package has its own README:

- [`@ctd/sdk`](packages/sdk/README.md) — the client SDK (crypto · witness · proving · chain · state · auditor · disclosure) and its test suite.
- [`@ctd/app`](packages/app/README.md) — the Next.js demo front-end: browser proving, cross-origin isolation, the bb.js vendoring rule, Cloudflare deploy.
- [`@ctd/disclosure`](packages/disclosure/README.md) — shared selective-disclosure circuits + pinned VKs (the off-chain trust anchor).
- [`@ctd/indexer`](packages/indexer/README.md) — the optional Goldsky indexer and its read API.

## RPC retention vs. indexer history

The protocol's spendable secrets (`v`, `r`) live only in events — the chain stores commitments, not openings — and the Soroban RPC serves only ~7 days of history. The client reconstructs balances from a hybrid event source (RPC for the recent tail, an optional Goldsky indexer for older history) and persists decrypted openings locally, re-checking them against the on-chain commitments. With RPC alone that local persistence is load-bearing: sync at least once per retention window, or an aged-out incoming-transfer opening becomes unrecoverable.

The reconstruction mechanics live in [`@ctd/sdk`](packages/sdk/README.md#state-reconstruction--retention); enabling the indexer in the app is covered in [`@ctd/app`](packages/app/README.md#event-history--the-indexer).

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
- For rebuilding contracts: Rust stable + `wasm32v1-none`, `stellar` CLI ≥ 25.2. The OpenZeppelin crates are pulled as **git dependencies** from the `feat/confidential-verifier-ultrahonk` branch (pinned by `Cargo.lock`) — no local checkout needed.
- For regenerating circuit artifacts only: `nargo` 1.0.0-beta.9, `bb` 0.87.0, and a local checkout of `OpenZeppelin/stellar-contracts` @ `feat/confidential-verifier-ultrahonk` at `../stellar-contracts-cv-ultrahonk` (the disclosure circuits' `Nargo.toml` path-depends on its Noir lib).

## License

MIT.
