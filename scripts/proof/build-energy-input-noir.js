const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const noirDir = path.join(root, "proof", "noir", "energy-input");
const targetDir = path.join(noirDir, "target");
const generatedDir = path.join(root, "contracts", "generated");
const artifact = path.join(targetDir, "energy_input_validation_noir.json");
const vkPath = path.join(targetDir, "vk");
const generatedVerifier = path.join(generatedDir, "NoirEnergyInputGeneratedVerifier.sol");
const oracleHash = process.env.FHEBC_NOIR_ORACLE_HASH ?? "keccak";
const useWslDocker = process.env.FHEBC_NOIR_RUNNER === "wsl-docker" || process.platform === "win32";

function bin(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
    env: { ...process.env, ...options.env }
  });
}

function wslPath(hostPath) {
  return execFileSync("wsl", ["wslpath", "-a", hostPath.replace(/\\/g, "/")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).trim();
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runWsl(script) {
  console.log(`> wsl bash -lc ${script}`);
  return execFileSync("wsl", ["bash", "-lc", script], {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    env: process.env
  });
}

function runBb(args) {
  if (!useWslDocker) {
    return run("bb", args);
  }
  const rootWsl = wslPath(root);
  const command = [
    "set -e",
    `cd ${shellQuote(rootWsl)}`,
    `docker run --rm -v "$HOME/.bb:/bb" -v "$PWD:/work" -w /work ubuntu:24.04 /bb/bb ${args.map(shellQuote).join(" ")}`
  ].join("; ");
  return runWsl(command);
}

function requireCommand(command, args) {
  try {
    execFileSync(command, args, { stdio: "ignore" });
  } catch {
    throw new Error(`Required command not found or not working: ${command}. Install it before building Noir proofs.`);
  }
}

function renameGeneratedVerifier(source) {
  const finalHonkVerifier = /contract\s+HonkVerifier\s+is\s+/;
  if (finalHonkVerifier.test(source)) {
    return source.replace(finalHonkVerifier, "contract NoirEnergyInputGeneratedVerifier is ");
  }
  const finalUltraVerifier = /contract\s+UltraVerifier\s+is\s+/;
  if (finalUltraVerifier.test(source)) {
    return source.replace(finalUltraVerifier, "contract NoirEnergyInputGeneratedVerifier is ");
  }
  const inheritingVerifier = /contract\s+[A-Za-z0-9_]*Verifier\s+is\s+/;
  if (inheritingVerifier.test(source)) {
    return source.replace(inheritingVerifier, "contract NoirEnergyInputGeneratedVerifier is ");
  }
  const plainVerifier = /contract\s+[A-Za-z0-9_]*Verifier\s*\{/;
  if (plainVerifier.test(source)) {
    return source.replace(plainVerifier, "contract NoirEnergyInputGeneratedVerifier {");
  }
  throw new Error("Could not find the generated verifier contract name to rename.");
}

if (useWslDocker) {
  const noirDirWsl = wslPath(noirDir);
  runWsl(
    `set -e; export PATH="$HOME/.nargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"; cd ${shellQuote(
      noirDirWsl
    )}; nargo --version; docker run --rm -v "$HOME/.bb:/bb" ubuntu:24.04 /bb/bb --version`
  );
} else {
  requireCommand("nargo", ["--version"]);
  requireCommand("bb", ["--version"]);
}

fs.mkdirSync(generatedDir, { recursive: true });

if (useWslDocker) {
  const noirDirWsl = wslPath(noirDir);
  runWsl(
    `set -e; export PATH="$HOME/.nargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"; cd ${shellQuote(
      noirDirWsl
    )}; nargo compile`
  );
} else {
  run("nargo", ["compile"], { cwd: noirDir });
}
if (!fs.existsSync(artifact)) {
  throw new Error(`Noir artifact not found: ${artifact}`);
}

runBb([
  "write_vk",
  "-b",
  path.relative(root, artifact).replace(/\\/g, "/"),
  "-o",
  path.relative(root, targetDir).replace(/\\/g, "/"),
  "--oracle_hash",
  oracleHash
]);
if (!fs.existsSync(vkPath)) {
  throw new Error(`Barretenberg verification key not found: ${vkPath}`);
}

runBb([
  "write_solidity_verifier",
  "-k",
  path.relative(root, vkPath).replace(/\\/g, "/"),
  "-o",
  path.relative(root, generatedVerifier).replace(/\\/g, "/")
]);
const rawVerifier = fs.readFileSync(generatedVerifier, "utf8");
fs.writeFileSync(generatedVerifier, renameGeneratedVerifier(rawVerifier));

console.log("\nNoir energy input artifacts generated:");
console.log(`  artifact : ${artifact}`);
console.log(`  vk       : ${vkPath}`);
console.log(`  verifier : ${generatedVerifier}`);
console.log(`  oracle   : ${oracleHash}`);
