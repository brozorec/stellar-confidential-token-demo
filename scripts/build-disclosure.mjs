// Builds the shared selective-disclosure artifacts in packages/disclosure:
//   artifacts/<circuit>.json     compiled ACIR circuit (nargo)
//   artifacts/<circuit>.vk.json  UltraHonk verification key (keccak
//                                transcript), base64
//
// Both the proving party (holder wallet) and the disclosure receiver (verify
// page) load these same files — the VK is the receiver's trusted input
// (SELECTIVE_DISCLOSURE.md §5.5), so it is generated here with the SAME bb.js
// build the browser runs (`getVerificationKey({ keccak: true })`) and pinned
// at verification time against a fresh derivation from the circuit bytecode.
//
// Run from the repo root:  pnpm build:disclosure
// (executes inside the @ctd/sdk package so bb.js resolves; requires nargo
// 1.0.0-beta.11 on PATH and the bb CRS cache, same as the SDK prove tests).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const CIRCUITS = ["disclose_recipient", "disclose_sender"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "packages", "disclosure");
const artifactsDir = join(pkg, "artifacts");
mkdirSync(artifactsDir, { recursive: true });

// Resolve bb.js through the SDK package (this script lives outside any
// package, so bare-specifier resolution from its own path would fail).
const sdkRequire = createRequire(join(root, "packages", "sdk", "package.json"));
const { UltraHonkBackend } = await import(pathToFileURL(sdkRequire.resolve("@aztec/bb.js")).href);

for (const name of CIRCUITS) {
  const circuitDir = join(pkg, "circuits", name);

  console.log(`==> nargo compile ${name}`);
  execFileSync("nargo", ["compile"], { cwd: circuitDir, stdio: "inherit" });

  const artifact = join(artifactsDir, `${name}.json`);
  copyFileSync(join(circuitDir, "target", `${name}.json`), artifact);
  const circuit = JSON.parse(readFileSync(artifact, "utf8"));
  console.log(`    wrote artifacts/${name}.json (noir ${circuit.noir_version})`);

  console.log(`==> deriving UltraHonk VK (keccak transcript) via bb.js`);
  const backend = new UltraHonkBackend(circuit.bytecode);
  const vk = await backend.getVerificationKey({ keccak: true });
  await backend.destroy();

  const vkJson = {
    circuitId: name,
    scheme: "ultra_honk",
    oracleHash: "keccak",
    noirVersion: circuit.noir_version,
    vkBase64: Buffer.from(vk).toString("base64"),
  };
  writeFileSync(join(artifactsDir, `${name}.vk.json`), JSON.stringify(vkJson, null, 2) + "\n");
  console.log(`    wrote artifacts/${name}.vk.json (${vk.length}B VK)`);
}
