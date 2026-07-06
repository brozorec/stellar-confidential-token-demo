//! BlockList compliance policy contract.
//!
//! A standalone blocklist registry that plugs into the confidential token as an
//! external authorization [`Policy`]: an address that is `block`ed is denied.
//! State is a single persistent flag per address (`blocked`); membership emits
//! `["block", addr]` / `["unblock", addr]` events. The block/unblock/query
//! logic is reused from `stellar_tokens::fungible::blocklist::BlockList`, which
//! is decoupled from any token transfer logic.
//!
//! The token consumes this contract through [`Policy::is_authorized`]: when set
//! as the compliance `policy`, [`ComplianceHooks`] reverts every gated op for a
//! blocked account. The `token` argument is ignored — the blocklist is global
//! to this registry instance.
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
use stellar_tokens::fungible::blocklist::BlockList;

#[contract]
pub struct BlockListContract;

#[contractimpl]
impl BlockListContract {
    /// Sets the contract owner. Only the owner can `block` / `unblock`.
    pub fn __constructor(e: &Env, owner: Address) {
        set_owner(e, &owner);
    }

    /// Adds `user` to the blocklist. Idempotent (no-op if already blocked).
    #[only_owner]
    pub fn block(e: &Env, user: Address) {
        BlockList::block_user(e, &user);
    }

    /// Removes `user` from the blocklist. Idempotent (no-op if not blocked).
    #[only_owner]
    pub fn unblock(e: &Env, user: Address) {
        BlockList::unblock_user(e, &user);
    }

    /// Returns whether `account` is currently blocked.
    pub fn blocked(e: &Env, account: Address) -> bool {
        BlockList::blocked(e, &account)
    }
}

/// External authorization policy: an account is authorized iff it is not
/// blocked. Called cross-contract by the confidential token's `ComplianceHooks`.
#[contractimpl]
impl Policy for BlockListContract {
    fn is_authorized(e: Env, account: Address, _token: Address) -> bool {
        !BlockList::blocked(&e, &account)
    }
}

#[contractimpl(contracttrait)]
impl Ownable for BlockListContract {}
