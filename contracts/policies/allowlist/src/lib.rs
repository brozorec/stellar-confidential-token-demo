//! AllowList compliance policy contract.
//!
//! A standalone allowlist registry that plugs into the confidential token as an
//! external authorization [`Policy`]: an address must be explicitly `allow`ed
//! to be authorized. State is a single persistent flag per address (`allowed`);
//! membership emits `["allow", addr]` / `["disallow", addr]` events. The
//! allow/disallow/query logic is reused from
//! `stellar_tokens::fungible::allowlist::AllowList`, which is decoupled from any
//! token transfer logic.
//!
//! The token consumes this contract through [`Policy::is_authorized`]: when set
//! as the compliance `policy`, [`ComplianceHooks`] reverts every gated op for an
//! account that is not allowed. The `token` argument is ignored — the allowlist
//! is global to this registry instance.
//!
//! Mutations are gated by the `ownable` access pattern from stellar-contracts:
//! the owner is set at construction and `#[only_owner]` requires the owner's
//! authorization. Ownership uses the 2-step transfer exposed by the [`Ownable`]
//! trait (`transfer_ownership` + `accept_ownership`).
//!
//! [`Policy`]: stellar_tokens::confidential::compliance::Policy
//! [`ComplianceHooks`]: stellar_tokens::confidential::compliance::ComplianceHooks
#![no_std]

use soroban_sdk::{contract, contractimpl, Address, Env};
use stellar_access::ownable::{set_owner, Ownable};
use stellar_macros::only_owner;
use stellar_tokens::confidential::compliance::Policy;
use stellar_tokens::fungible::allowlist::AllowList;

#[contract]
pub struct AllowListContract;

#[contractimpl]
impl AllowListContract {
    /// Sets the contract owner. Only the owner can `allow` / `disallow`.
    pub fn __constructor(e: &Env, owner: Address) {
        set_owner(e, &owner);
    }

    /// Adds `user` to the allowlist. Idempotent (no-op if already allowed).
    #[only_owner]
    pub fn allow(e: &Env, user: Address) {
        AllowList::allow_user(e, &user);
    }

    /// Removes `user` from the allowlist. Idempotent (no-op if not allowed).
    #[only_owner]
    pub fn disallow(e: &Env, user: Address) {
        AllowList::disallow_user(e, &user);
    }

    /// Returns whether `account` is currently allowed.
    pub fn allowed(e: &Env, account: Address) -> bool {
        AllowList::allowed(e, &account)
    }
}

/// External authorization policy: an account is authorized iff it is allowed.
/// Called cross-contract by the confidential token's `ComplianceHooks`.
#[contractimpl]
impl Policy for AllowListContract {
    fn is_authorized(e: Env, account: Address, _token: Address) -> bool {
        AllowList::allowed(&e, &account)
    }
}

#[contractimpl(contracttrait)]
impl Ownable for AllowListContract {}
