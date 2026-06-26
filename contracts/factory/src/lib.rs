//! Token factory contract.
//!
//! Deploys the demo's confidential-token instances from WASM already installed
//! on-chain, in three flavors:
//!
//! 1. [`deploy_token`](TokenFactoryContract::deploy_token) — a **vanilla**
//!    confidential token (`type Hooks = NoHooks`, no compliance).
//! 2. [`deploy_compliant_token`](TokenFactoryContract::deploy_compliant_token) —
//!    a **compliant** token (`type Hooks = ComplianceHooks`). Pass `policy =
//!    None` for "compliance only" (freeze + SAC, no external policy), or
//!    `Some(addr)` to bind an already-deployed policy.
//! 3. [`deploy_policy_and_token`](TokenFactoryContract::deploy_policy_and_token)
//!    — deploys a **fresh policy** (allowlist or blocklist) and then a compliant
//!    token bound to it, in one call.
//!
//! ## How it works
//!
//! The factory is configured at construction with the WASM hash of each
//! deployable contract (obtained off-chain via `stellar contract upload`, or
//! on-chain via [`Deployer::upload_contract_wasm`]). Each deploy uses
//! `env.deployer().with_current_contract(salt)`, so the factory itself is the
//! deployer and the resulting contract address is deterministic in
//! `(factory_address, salt)` — **callers must pass a unique salt per deployed
//! contract** or the deploy traps on collision.
//!
//! The factory deploys purely by hash + constructor-arg tuple; it does **not**
//! depend on the token/policy crates. The arg tuples below therefore mirror the
//! downstream constructors by convention, not by the type system — if a
//! downstream `__constructor` signature changes, update the matching tuple here.
//!
//! Deploys are **permissionless** (a demo choice): anyone can mint an instance,
//! but each instance carries its own `owner` / compliance config from the args.
//!
//! [`Deployer::upload_contract_wasm`]: soroban_sdk::deploy::Deployer::upload_contract_wasm
//!
//! # ⚠️ Not Production Ready
//!
//! Part of an unaudited confidential-token demo. Do not use with real value.
#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

/// Instance-storage keys: one WASM hash per deployable contract kind.
#[contracttype]
pub enum FactoryStorageKey {
    /// Vanilla `ConfidentialToken` (`NoHooks`).
    VanillaTokenWasm,
    /// `TokenWithCompliance` (`ComplianceHooks`).
    CompliantTokenWasm,
    /// `AllowList` policy.
    AllowListWasm,
    /// `BlockList` policy.
    BlockListWasm,
}

/// Which policy flavor to deploy in
/// [`deploy_policy_and_token`](TokenFactoryContract::deploy_policy_and_token).
#[contracttype]
#[derive(Clone, Copy)]
pub enum PolicyKind {
    AllowList,
    BlockList,
}

#[contract]
pub struct TokenFactoryContract;

#[contractimpl]
impl TokenFactoryContract {
    /// Stores the WASM hash of each deployable contract. Each must already be
    /// installed on-chain (`stellar contract upload`) so the factory can deploy
    /// instances by hash.
    pub fn __constructor(
        e: &Env,
        vanilla_token_wasm: BytesN<32>,
        compliant_token_wasm: BytesN<32>,
        allowlist_wasm: BytesN<32>,
        blocklist_wasm: BytesN<32>,
    ) {
        let s = e.storage().instance();
        s.set(&FactoryStorageKey::VanillaTokenWasm, &vanilla_token_wasm);
        s.set(&FactoryStorageKey::CompliantTokenWasm, &compliant_token_wasm);
        s.set(&FactoryStorageKey::AllowListWasm, &allowlist_wasm);
        s.set(&FactoryStorageKey::BlockListWasm, &blocklist_wasm);
    }

    /// (1) Deploy a vanilla confidential token bound to the given collaborators.
    /// Mirrors `ConfidentialTokenContract::__constructor`.
    pub fn deploy_token(
        e: &Env,
        salt: BytesN<32>,
        underlying_asset: Address,
        verifier: Address,
        auditor: Address,
    ) -> Address {
        let wasm = read_wasm(e, FactoryStorageKey::VanillaTokenWasm);
        e.deployer()
            .with_current_contract(salt)
            .deploy_v2(wasm, (underlying_asset, verifier, auditor))
    }

    /// (2) Deploy a compliant token. `policy = None` ⇒ compliance only
    /// (freeze + SAC); `Some(addr)` binds an existing policy contract.
    /// Mirrors `TokenWithComplianceContract::__constructor`.
    pub fn deploy_compliant_token(
        e: &Env,
        salt: BytesN<32>,
        owner: Address,
        underlying_asset: Address,
        verifier: Address,
        auditor: Address,
        policy: Option<Address>,
    ) -> Address {
        deploy_compliant(e, salt, owner, underlying_asset, verifier, auditor, policy)
    }

    /// (3) Deploy a fresh policy (allowlist or blocklist) owned by
    /// `policy_owner`, then a compliant token bound to it. Returns
    /// `(policy_address, token_address)`.
    pub fn deploy_policy_and_token(
        e: &Env,
        policy_kind: PolicyKind,
        policy_salt: BytesN<32>,
        policy_owner: Address,
        token_salt: BytesN<32>,
        token_owner: Address,
        underlying_asset: Address,
        verifier: Address,
        auditor: Address,
    ) -> (Address, Address) {
        let policy_wasm = read_wasm(
            e,
            match policy_kind {
                PolicyKind::AllowList => FactoryStorageKey::AllowListWasm,
                PolicyKind::BlockList => FactoryStorageKey::BlockListWasm,
            },
        );
        let policy = e
            .deployer()
            .with_current_contract(policy_salt)
            .deploy_v2(policy_wasm, (policy_owner,));

        let token = deploy_compliant(
            e,
            token_salt,
            token_owner,
            underlying_asset,
            verifier,
            auditor,
            Some(policy.clone()),
        );

        (policy, token)
    }
}

/// Reads a stored WASM hash; panics if the factory was not configured with one.
fn read_wasm(e: &Env, key: FactoryStorageKey) -> BytesN<32> {
    e.storage().instance().get(&key).expect("factory wasm hash not set")
}

/// Shared body for deploying a `TokenWithCompliance` instance.
fn deploy_compliant(
    e: &Env,
    salt: BytesN<32>,
    owner: Address,
    underlying_asset: Address,
    verifier: Address,
    auditor: Address,
    policy: Option<Address>,
) -> Address {
    let wasm = read_wasm(e, FactoryStorageKey::CompliantTokenWasm);
    e.deployer()
        .with_current_contract(salt)
        .deploy_v2(wasm, (owner, underlying_asset, verifier, auditor, policy))
}
