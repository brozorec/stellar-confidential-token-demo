// Fast wiring smoke test (no noir_js): confirms the noble curve config,
// generators, scalar mul, Pedersen commitment homomorphism, and the Poseidon2
// sponge all execute and satisfy basic algebraic identities.
import {
  G, H, Grumpkin, scalarMul, commit, pointToBytes, pointFromBytes, isIdentity,
} from "../src/crypto/grumpkin.ts";
import { sponge, poseidonWithDomain, vkFromSk } from "../src/crypto/poseidon2.ts";
import { addressToField } from "../src/crypto/address.ts";
import { G_X, G_Y, H_X, H_Y, FR_MODULUS } from "../src/crypto/constants.ts";
import { frAdd, fpAdd } from "../src/crypto/field.ts";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("  ✗ " + msg); } };

// Generators match constants and are on-curve (noble asserts on construction).
ok(G.toAffine().x === G_X && G.toAffine().y === G_Y, "G == (G_X, G_Y)");
ok(H.toAffine().x === H_X && H.toAffine().y === H_Y, "H == (H_X, H_Y)");
ok(!G.equals(H), "G != H");

// Pedersen homomorphism: commit(a,b)+commit(c,d) == commit(a+c, b+d).
const c1 = commit(11n, 22n), c2 = commit(33n, 44n);
ok(c1.add(c2).equals(commit(44n, 66n)), "Pedersen additively homomorphic");

// Blinding accumulation is mod p (the GROUP order), not mod r: when the
// integer sum of two blindings crosses p, only the mod-p reduction still
// opens the summed commitment. Reducing mod r instead diverges by p - r
// (regression: state engine used frAdd here and mismatched on-chain state
// after any merge of two full-size blindings).
const rBig1 = FR_MODULUS - 1n, rBig2 = FR_MODULUS - 2n; // sum > p
const cSum = commit(5n, rBig1).add(commit(7n, rBig2));
ok(cSum.equals(commit(12n, fpAdd(rBig1, rBig2))), "mod-p blinding sum opens point sum");
ok(!cSum.equals(commit(12n, frAdd(rBig1, rBig2))), "mod-r blinding sum must NOT open it");

// commit(0,0) is the identity, and round-trips through bytes as 64 zeros.
ok(isIdentity(commit(0n, 0n)), "commit(0,0) is identity");
const zb = pointToBytes(commit(0n, 0n));
ok(zb.length === 64 && zb.every((x) => x === 0), "identity -> 64 zero bytes");
ok(isIdentity(pointFromBytes(zb)), "64 zero bytes -> identity");

// Point byte round-trip for a non-identity point.
const P = scalarMul(123456789n, G);
ok(pointFromBytes(pointToBytes(P)).equals(P), "point bytes round-trip");

// scalarMul distributes: (a+b)·G == a·G + b·G.
ok(scalarMul(7n, G).add(scalarMul(9n, G)).equals(scalarMul(16n, G)), "scalarMul distributes");

// Poseidon2 sponge is deterministic and reduces into the field.
const h1 = poseidonWithDomain(2n, [123n, 456n]);
const h2 = poseidonWithDomain(2n, [123n, 456n]);
ok(h1 === h2, "sponge deterministic");
ok(h1 >= 0n && h1 < FR_MODULUS, "sponge output in field");
ok(vkFromSk(123n, 456n) === h1, "vkFromSk == poseidon(VIEWING_KEY, sk, addr_f)");
ok(sponge([1n, 2n, 3n]) !== sponge([1n, 2n, 4n]), "sponge sensitive to input");

// address_to_field accepts a 56-char strkey and yields a field element.
const sample = "CCREDIB3DG3IBVUKBL7QMEK4MTPSTODR7MQ34QY4SQ5LZ5L4WFWNVNXG";
try {
  const af = addressToField(sample);
  ok(af >= 0n && af < FR_MODULUS, "addressToField in field");
} catch (e) {
  ok(false, "addressToField threw: " + e.message);
}

console.log(`\nsmoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
