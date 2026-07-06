/**
 * Human-readable messages for on-chain contract errors.
 *
 * Soroban surfaces a failed contract call as a `HostError` whose string carries
 * `Error(Contract, #NNNN)`, where `NNNN` is a `#[contracterror]` discriminant.
 * The raw HostError (with its diagnostic event log) is unreadable in a UI, so
 * this maps the known codes — from the confidential-token, compliance, ownable,
 * and access-control error enums — to plain language.
 *
 * Codes mirror the contracts' error enums; keep in sync if those change:
 *   - AccessControlError 2000–2009  (stellar_access::access_control)
 *   - OwnableError       2100–2102  (stellar_access::ownable)
 *   - ConfidentialTokenError 3500–3514
 *   - ComplianceError    3600–3603
 */

export const CONTRACT_ERRORS: Readonly<Record<number, string>> = {
  // Access control
  2000: "Not authorized: this account lacks the required role.",
  2001: "The contract admin is not set.",
  // Ownable
  2100: "This contract has no owner set.",
  2101: "An ownership transfer is already in progress.",
  2102: "The owner is already set.",
  // Confidential token
  3500: "This account is already registered.",
  3501: "Account is not registered — register a confidential balance before transacting.",
  3502: "Amount must be non-negative.",
  3503: "A spender delegation already exists.",
  3504: "Spender delegation not found.",
  3505: "Spender delegation has expired.",
  3506: "Zero-knowledge proof verification failed.",
  3507: "Invalid operation data.",
  3508: "The token's underlying asset is not configured.",
  3509: "The token's verifier is not configured.",
  3510: "The token's auditor is not configured.",
  3511: "The token's address-as-field is not set.",
  3512: "The token's address-as-field is already set.",
  3513: "The token's underlying asset is already set.",
  3514: "Non-canonical point encoding.",
  // Compliance (token_with_compliance)
  3600: "Compliance is not configured for this token.",
  3601: "This account is frozen and cannot transact. Ask the token admin to unfreeze it.",
  3602:
    "This account is not permitted by the token's compliance policy (allowlist/blocklist). Ask the admin to allow it.",
  3603: "This account is not authorized by the underlying asset.",
};

const CONTRACT_CODE_RE = /Error\(Contract,\s*#(\d+)\)/;

/** The contract error code embedded in a raw HostError string, or `null`. */
export function parseContractErrorCode(raw: string): number | null {
  const m = CONTRACT_CODE_RE.exec(raw);
  return m ? Number(m[1]) : null;
}

/**
 * Translate a raw error string to a friendly message when it carries a known
 * contract error code; otherwise `null` (caller falls back to the raw text).
 */
export function humanizeContractError(raw: string): string | null {
  const code = parseContractErrorCode(raw);
  if (code === null) return null;
  return CONTRACT_ERRORS[code] ?? `The contract rejected the operation (error #${code}).`;
}
