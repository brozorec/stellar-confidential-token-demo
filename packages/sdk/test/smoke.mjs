// Fast wiring smoke test (no noir_js): confirms the noble curve config,
// generators, scalar mul, Pedersen commitment homomorphism, and the Poseidon2
// sponge all execute and satisfy basic algebraic identities.
import {
  G, H, Grumpkin, scalarMul, commit, pointToBytes, pointFromBytes, isIdentity,
} from "../src/crypto/grumpkin.ts";
import { sponge, poseidonWithDomain, vkFromSk } from "../src/crypto/poseidon2.ts";
import { addressToField } from "../src/crypto/address.ts";
import { G_X, G_Y, H_X, H_Y, FR_MODULUS, DOMAIN } from "../src/crypto/constants.ts";
import { frAdd, fpAdd, randomScalar } from "../src/crypto/field.ts";

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

// Domain separators are a cross-implementation contract (SDK.md §4.8): the
// sixteen tags must be exactly 1..16 and distinct. Tags 14-16 are absorbed
// neither in a circuit nor on-chain, so NO proof or contract call fails if they
// drift — only cross-client reads break, silently. Pinning them here is the
// only guard. (Regression: EPHEMERAL_KEY and DISCLOSURE_BIND were swapped,
// 15/14 instead of the spec's 14/15, which broke sender disclosability for any
// second client following the spec.)
const tags = Object.values(DOMAIN);
ok(tags.length === 16, "sixteen domain tags");
ok(new Set(tags).size === tags.length, "domain tags distinct");
ok(
  tags.slice().sort((a, b) => Number(a - b)).every((t, i) => t === BigInt(i + 1)),
  "domain tags are exactly 1..16",
);
ok(DOMAIN.AUDITOR_SENDER === 11n && DOMAIN.AUDITOR_RECIPIENT === 12n, "auditor tags 11/12");
ok(DOMAIN.ECDH_SHARED_SECRET === 13n, "delta_ecdh == 13");
ok(DOMAIN.EPHEMERAL_KEY === 14n, "delta_eph == 14");
ok(DOMAIN.DISCLOSURE_BIND === 15n, "delta_disc_bind == 15");
ok(DOMAIN.DISCLOSURE === 16n, "delta_disc == 16");

// randomScalar must be uniform on [1, r) via the SDK.md §4.7 rejection
// procedure: clear the top 2 BITS, redraw if >= r. Masking the whole top byte
// instead (the regression) never rejects and caps every draw below 2^248,
// losing ~6 bits and — because the same procedure is §5.1's `RS` step —
// deriving a different sk than a conforming client from the same root.
const draws = Array.from({ length: 300 }, () => randomScalar());
ok(draws.every((v) => v > 0n && v < FR_MODULUS), "randomScalar in [1, r)");
ok(draws.every((v) => v < 1n << 254n), "randomScalar clears the top 2 bits");
ok(draws.some((v) => v >= 1n << 250n), "randomScalar reaches the full 254-bit range");
ok(new Set(draws).size === draws.length, "randomScalar draws distinct");

console.log(`\nsmoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
