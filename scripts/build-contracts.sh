#!/usr/bin/env bash
# Builds the three demo contracts to wasm and copies the artifacts into
# packages/sdk/contracts/ so the SDK/deploy script can load them.
#
# Requires the pinned stable Rust toolchain with the wasm32v1-none target
# (see contracts/rust-toolchain.toml) and a local checkout of
# OpenZeppelin/stellar-contracts @ feat/confidential-verifier-ultrahonk at the
# path declared in contracts/Cargo.toml.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contracts"

TARGET="wasm32v1-none"
OUT_DIR="$ROOT/packages/sdk/contracts"
mkdir -p "$OUT_DIR"

echo "==> Building contracts with 'stellar contract build' (target $TARGET)"
# `stellar contract build` is required (not plain `cargo build`) because the
# stellar-tokens dependency enables soroban-sdk's experimental_spec_shaking_v2
# feature, which only the stellar-cli build path supports.
stellar contract build

declare -A WASMS=(
  ["confidential_token_contract"]="confidential_token"
  ["token_with_compliance_contract"]="token_with_compliance"
  ["confidential_verifier_contract"]="confidential_verifier"
  ["confidential_auditor_contract"]="confidential_auditor"
  ["allowlist_contract"]="allowlist"
  ["blocklist_contract"]="blocklist"
  ["token_factory_contract"]="token_factory"
)

WASM_DIR="target/$TARGET/release"
for src in "${!WASMS[@]}"; do
  dst="${WASMS[$src]}"
  cp "$WASM_DIR/${src}.wasm" "$OUT_DIR/${dst}.wasm"
  echo "    wrote $OUT_DIR/${dst}.wasm ($(wc -c < "$OUT_DIR/${dst}.wasm") bytes)"
done

echo "Done."
