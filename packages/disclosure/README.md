# @ctd/disclosure — shared selective-disclosure artifacts

The off-chain selective-disclosure layer lets an account holder prove **one fact about one on-chain event** to **one designated recipient**. Two variants are implemented: D-recipient (§6, *"this on-chain transfer paid me exactly X"*) and D-sender (§7, *"I sent this on-chain transfer for exactly X"* — requires the ephemeral scalar `r_e` the wallet retained at transfer time, §15.2). The contract is untouched; proving and verifying both happen client-side, with the chain as a read-only source of truth.

This package is the **trust anchor** the two off-chain parties share (§5.5): the prover (holder wallet, `/` page) and the disclosure receiver (`/verify` page) must agree out-of-band on which compiled circuit a `circuit_id` denotes. Both load the same files from here:

| File | Used by | Purpose |
|:---|:---|:---|
| `circuits/disclose_recipient/` | auditors / reviewers | Noir source of the D-recipient circuit (constraints D1–D5 + U1–U3). `nargo test` covers the happy path and seven tamper cases. |
| `circuits/disclose_sender/` | auditors / reviewers | Noir source of the D-sender circuit (D1/D2 + DS3–DS5 + D5 + U1–U3); proves origination via the retained `r_e` and pins **who was paid** through `PVK_B`. |
| `artifacts/<circuit>.json` | prover **and** receiver | Compiled ACIR. The prover solves witnesses + proves against it; the receiver derives its verification key from it. |
| `artifacts/<circuit>.vk.json` | receiver | Pinned UltraHonk verification key (keccak transcript, base64), one per circuit — the bundle's `circuit_id` selects which pair the receiver loads. The receiver requires the bytecode-derived VK to match these bytes before trusting any verify result. |

Rebuild after editing the circuit:

```sh
pnpm build:disclosure   # nargo compile + VK via bb.js (keccak), writes artifacts/
```

Requires `nargo 1.0.0-beta.11` and the `stellar_confidential_lib` checkout the `Nargo.toml` points at (the same path-dependency the contracts use). The VK is generated through bb.js — the exact library the browser runs — so the pin is byte-for-byte by construction.

Remaining disclosure variants (D-auditor §8, D-balance §9, aggregates §10) belong here as sibling circuit packages with their own artifact pairs.

The protocol logic lives in `@ctd/sdk` (`src/disclosure/`): witness building + `proveRecipientDisclosure` / `proveSenderDisclosure` on the holder side, and `verifyDisclosure` — the mandatory §5.3 verifier protocol, branching its account lookups on the bundle's `circuit_id` — on the receiver side. Domain separator: `δ_disc = 13` (`DOMAIN.DISCLOSURE`), shared by the whole circuit family's U-block.
