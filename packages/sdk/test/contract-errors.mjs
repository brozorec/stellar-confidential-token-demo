// Offline test for the contract-error humanizer: a raw soroban HostError string
// carrying `Error(Contract, #NNNN)` must map to a friendly message for known
// codes, and pass through unknown / non-contract errors. Runs with no infra.

import { humanizeContractError, parseContractErrorCode, CONTRACT_ERRORS } from "../src/chain/errors.ts";

let pass = 0,
  fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// The exact shape the RPC/SDK surfaces for a frozen account on deposit.
const FROZEN_RAW =
  'simulate deposit failed: HostError: Error(Contract, #3601) Event log (newest first): 0: [Diagnostic Event] ...';

check("parses code from a real HostError string", parseContractErrorCode(FROZEN_RAW) === 3601);
check(
  "frozen (3601) → friendly message",
  humanizeContractError(FROZEN_RAW) === CONTRACT_ERRORS[3601],
  humanizeContractError(FROZEN_RAW),
);
check("3601 message mentions frozen", /frozen/i.test(CONTRACT_ERRORS[3601]));
check("not-registered (3501) maps", humanizeContractError("Error(Contract, #3501)") === CONTRACT_ERRORS[3501]);
check(
  "policy denial (3602) maps",
  humanizeContractError("HostError: Error(Contract, #3602)") === CONTRACT_ERRORS[3602],
);
check(
  "unknown contract code → generic contract message",
  humanizeContractError("Error(Contract, #9999)") === "The contract rejected the operation (error #9999).",
);
check("non-contract error → null (passes through)", humanizeContractError("Freighter not detected") === null);
check("no code present → null", parseContractErrorCode("some random text") === null);

console.log(`\ncontract-errors: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
