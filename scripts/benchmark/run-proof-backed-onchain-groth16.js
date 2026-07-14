#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { ethers } = require("ethers");
const circomlibjs = require("circomlibjs");

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
}

async function poseidonCommitment(secret) {
  const poseidon = await circomlibjs.buildPoseidon();
  return ethers.toBeHex(poseidon.F.toObject(poseidon([BigInt(secret)])), 32);
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const runs = process.argv[2] ?? process.env.FHEBC_BENCHMARK_RUNS ?? "1";
  const secret = process.env.FHEBC_OPERATION_ZK_SECRET ?? "12345";
  const commitment = process.env.FHEBC_OPERATION_ZK_AUTHORITY_COMMITMENT ?? (await poseidonCommitment(secret));
  const outDir =
    process.env.FHEBC_BENCHMARK_OUT_DIR ??
    path.join("runtime", "benchmarks", `besufhe-proof-backed-onchain-groth16-${timestamp()}`);

  const env = {
    ...process.env,
    FHEBC_BENCHMARK_RUNS: runs,
    FHEBC_BENCHMARK_OPERATION_PROOF_MODE: "groth16",
    FHEBC_BENCHMARK_INPUT_PROOF_MODE: process.env.FHEBC_BENCHMARK_INPUT_PROOF_MODE ?? "mock",
    FHEBC_BENCHMARK_ALL_PROOF_BACKED: "1",
    FHEBC_OPERATION_ZK_SECRET: secret,
    FHEBC_OPERATION_ZK_AUTHORITY_COMMITMENT: commitment,
    FHEBC_BENCHMARK_OUT_DIR: outDir,
  };

  console.log("BesuFHE proof-backed on-chain Groth16 benchmark");
  console.log(`Runs                : ${runs}`);
  console.log(`Input proof mode    : ${env.FHEBC_BENCHMARK_INPUT_PROOF_MODE}`);
  console.log(`Operation proof mode: ${env.FHEBC_BENCHMARK_OPERATION_PROOF_MODE}`);
  console.log(`Authority commitment: ${commitment}`);
  console.log(`Output dir          : ${outDir}`);

  const hardhatArgs = ["hardhat", "run", "scripts/interact/energy-notary-benchmark-10x.ts", "--network", "fhebcBesu"];
  const command = process.platform === "win32" ? "cmd.exe" : "npx";
  const args =
    process.platform === "win32" ? ["/d", "/s", "/c", ["npx", ...hardhatArgs].join(" ")] : hardhatArgs;
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
