//! Confidential Token demo contract **with compliance**.
//!
//! Identical to the plain `token` wrapper but with the upstream compliance
//! extension wired in:
//!
//! * `type Hooks = ComplianceHooks;` — every operation (`register`, `deposit`,
//!   `merge`, `withdraw`, `confidential_transfer`, spender ops) is gated
//!   against the active [`ComplianceConfig`]: frozen accounts are rejected, an
//!   optional external [`Policy`] (e.g. the `allowlist` / `blocklist`
//!   contracts) is consulted, and an optional SAC `authorized()` passthrough is
//!   enforced.
//! * `impl ConfidentialCompliance` — the admin surface (`freeze`, `unfreeze`,
//!   `set_compliance_config`) plus the `is_frozen` / `compliance_config` reads.
//!
//! Like the plain token, the constructor binds three immutable collaborators
//! (`underlying_asset`, `verifier`, `auditor`) and freezes the address-as-field.
//! It additionally sets an `owner` and writes the initial [`ComplianceConfig`].
//! Writing a config at construction is what makes compliance *active*: the
//! hooks short-circuit to a no-op whenever no config is present, so even a
//! policy-free, SAC-free config (`policy = None`, `sac_passthrough = false`) is
//! required for `freeze` to take effect.
//!
//! Access control is `ownable`: the three write methods carry `#[only_owner]`,
//! which requires the stored owner's authorization. The trait's `operator`
//! parameter is therefore the *documented* caller and is not itself trusted —
//! the owner gate is what authorizes the call.
//!
//! [`Policy`]: stellar_tokens::confidential::compliance::Policy
//! [`ComplianceConfig`]: stellar_tokens::confidential::compliance::ComplianceConfig
//!
//! # ⚠️ Not Production Ready
//!
//! The UltraHonk verifier backend and the circuits the verification keys are
//! derived from are **unaudited**. Do not deploy anywhere handling real value.
#![no_std]

use soroban_sdk::{contract, contractimpl, Address, Bytes, Env};
use stellar_access::ownable::{set_owner, Ownable};
use stellar_macros::only_owner;
// `ConfidentialAccount` / `SpenderDelegation` / `Bytes` are referenced by the
// default trait-method bodies that `#[contractimpl(contracttrait)]` generates
// for the read endpoints and the proof-carrying entry points, so they must be
// in scope here even though this file never names them directly. Likewise
// `ComplianceConfig` is referenced by the generated `ConfidentialCompliance`
// read endpoints.
use stellar_tokens::confidential::{
    compliance::{
        storage as compliance_storage, ComplianceConfig, ComplianceHooks, ConfidentialCompliance,
    },
    storage as token_storage, ConfidentialAccount, ConfidentialToken, SpenderDelegation,
};

#[contract]
pub struct TokenWithComplianceContract;

#[contractimpl]
impl TokenWithComplianceContract {
    /// Binds the underlying SEP-41 asset, the verifier registry, and the
    /// auditor registry; freezes the address-as-field; sets the compliance
    /// `owner`; and activates compliance with the initial config.
    ///
    /// * `owner` — the account authorized to `freeze` / `unfreeze` and rotate
    ///   the compliance config.
    /// * `policy` — optional external [`Policy`] contract (allowlist /
    ///   blocklist / KYC). `None` enforces only freeze + SAC.
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        e: &Env,
        owner: Address,
        underlying_asset: Address,
        verifier: Address,
        auditor: Address,
        policy: Option<Address>,
    ) {
        set_owner(e, &owner);
        token_storage::set_underlying_asset(e, &underlying_asset);
        token_storage::set_verifier(e, &verifier);
        token_storage::set_auditor(e, &auditor);
        token_storage::set_address_as_field_element(e);
        compliance_storage::set_compliance_config(e, &ComplianceConfig { policy, sac_passthrough: true });
    }
}

#[contractimpl(contracttrait)]
impl ConfidentialToken for TokenWithComplianceContract {
    type Hooks = ComplianceHooks;
}

#[contractimpl(contracttrait)]
impl ConfidentialCompliance for TokenWithComplianceContract {
    /// Marks `account` as frozen. Owner-gated.
    #[only_owner]
    fn freeze(e: &Env, account: Address, _operator: Address) {
        compliance_storage::freeze(e, &account);
    }

    /// Clears the frozen flag on `account`. Owner-gated.
    #[only_owner]
    fn unfreeze(e: &Env, account: Address, _operator: Address) {
        compliance_storage::unfreeze(e, &account);
    }

    /// Atomically replaces the compliance configuration. Owner-gated.
    #[only_owner]
    fn set_compliance_config(e: &Env, config: ComplianceConfig, _operator: Address) {
        compliance_storage::set_compliance_config(e, &config);
    }
}

#[contractimpl(contracttrait)]
impl Ownable for TokenWithComplianceContract {}
