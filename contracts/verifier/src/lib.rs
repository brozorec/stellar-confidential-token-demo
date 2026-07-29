//! Confidential Verifier registry contract.
//!
//! Stores one UltraHonk verification key per [`CircuitType`] and exposes
//! `verify_proof`, which the confidential token calls cross-contract on every
//! state-changing operation. VK management (`register`/`update`) is gated
//! behind a `manager` role; `verify_proof` / `get_verification_key` use the
//! trait's default implementations, which run the UltraHonk backend from
//! `NethermindEth/rs-soroban-ultrahonk`.
//!
//! # ⚠️ Not Production Ready
//!
//! The UltraHonk backend and the circuits the keys are derived from are
//! **unaudited**. `update_verification_key` is soundness-critical: a wrong key
//! makes the verifier accept forged proofs. This contract gates it behind the
//! same `manager` role as registration purely for demo convenience; a real
//! deployment should ship VKs immutably or behind multisig + timelock.
#![no_std]

// `Vec` is referenced by the default `AccessControl` trait-method bodies that
// `#[contractimpl(contracttrait)]` generates, so it must be in scope here.
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Bytes, Env, Symbol, Vec};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_macros::only_role;
use stellar_tokens::confidential::verifier::{
    storage as verifier, CircuitType, ConfidentialVerifier,
};

const MANAGER_ROLE: Symbol = symbol_short!("manager");

#[contract]
pub struct ConfidentialVerifierContract;

#[contractimpl]
impl ConfidentialVerifierContract {
    pub fn __constructor(e: &Env, admin: Address, manager: Address) {
        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &manager, &MANAGER_ROLE, &admin);
    }
}

#[contractimpl(contracttrait)]
impl ConfidentialVerifier for ConfidentialVerifierContract {
    #[only_role(operator, "manager")]
    fn register_verification_key(
        e: &Env,
        circuit_type: CircuitType,
        verification_key: Bytes,
        operator: Address,
    ) {
        verifier::register_verification_key(e, circuit_type, &verification_key);
    }

    #[only_role(operator, "manager")]
    fn update_verification_key(
        e: &Env,
        circuit_type: CircuitType,
        new_verification_key: Bytes,
        operator: Address,
    ) {
        verifier::update_verification_key(e, circuit_type, &new_verification_key);
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for ConfidentialVerifierContract {}
