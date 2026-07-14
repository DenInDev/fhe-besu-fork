const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");

const root = path.resolve(__dirname, "..", "..", "..");
const bn254ScalarField =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const profiles = {
  "energy-input": {
    circuitDir: path.join(root, "proof", "groth16", "energy-input"),
    circuitFile: "energy_input.circom",
    baseName: "energy_input",
    contractName: "Groth16EnergyInputGeneratedVerifier",
    pairingName: "Groth16EnergyInputPairing",
    publicCount: 6,
  },
  "operation-authority": {
    circuitDir: path.join(root, "proof", "groth16", "operation-authority"),
    circuitFile: "operation_authority.circom",
    baseName: "operation_authority",
    contractName: "Groth16OperationGeneratedVerifier",
    pairingName: "Groth16OperationPairing",
    publicCount: 4,
  },
};

function profile(name) {
  const selected = profiles[name];
  if (!selected) {
    throw new Error(`Unknown Groth16 profile: ${name}. Expected one of: ${Object.keys(profiles).join(", ")}`);
  }
  const targetDir = path.join(selected.circuitDir, "target");
  return {
    ...selected,
    targetDir,
    circuitPath: path.join(selected.circuitDir, selected.circuitFile),
    r1csPath: path.join(targetDir, `${selected.baseName}.r1cs`),
    wasmPath: path.join(targetDir, `${selected.baseName}_js`, `${selected.baseName}.wasm`),
    witnessGeneratorPath: path.join(targetDir, `${selected.baseName}_js`, "generate_witness.js"),
    zkeyInitialPath: path.join(targetDir, `${selected.baseName}_0000.zkey`),
    zkeyFinalPath: path.join(targetDir, `${selected.baseName}_final.zkey`),
    verificationKeyPath: path.join(targetDir, "verification_key.json"),
    generatedVerifierPath: path.join(root, "contracts", "generated", `${selected.contractName}.sol`),
  };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
  });
}

function commandExists(command) {
  try {
    run(command, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function wslPath(hostPath) {
  return run("wsl", ["wslpath", "-a", hostPath.replace(/\\/g, "/")], {
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function wslCommandExists(command) {
  if (process.platform !== "win32") {
    return false;
  }
  try {
    run("wsl", ["bash", "-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`]);
    return true;
  } catch {
    return false;
  }
}

function runSnarkjs(args, options = {}) {
  return run(process.execPath, [path.join(root, "node_modules", "snarkjs", "build", "cli.cjs"), ...args], options);
}

function runCircom(circuitPath, targetDir) {
  const args = [
    circuitPath,
    "--r1cs",
    "--wasm",
    "--sym",
    "-o",
    targetDir,
    "-l",
    path.join(root, "node_modules"),
  ];
  if (commandExists("circom")) {
    return run("circom", args, { stdio: "inherit" });
  }
  if (wslCommandExists("circom")) {
    const command = [
      "set -e",
      `cd ${shellQuote(wslPath(root))}`,
      [
        "circom",
        shellQuote(wslPath(circuitPath)),
        "--r1cs",
        "--wasm",
        "--sym",
        "-o",
        shellQuote(wslPath(targetDir)),
        "-l",
        shellQuote(wslPath(path.join(root, "node_modules"))),
      ].join(" "),
    ].join("; ");
    return run("wsl", ["bash", "-lc", command], { stdio: "inherit" });
  }
  throw new Error(
    [
      "Missing `circom` binary.",
      "Install circom 2.x locally or in WSL and re-run this command,",
      "or set PATH so `circom --version` works from this shell.",
    ].join(" ")
  );
}

function splitBytes32(value) {
  const n = BigInt(value);
  return {
    hi: n >> 128n,
    lo: n & ((1n << 128n) - 1n),
  };
}

function fieldHex(value) {
  return ethers.toBeHex(BigInt(value), 32);
}

function requireField(value, label) {
  const n = BigInt(value);
  if (n < 0n || n >= bn254ScalarField) {
    throw new Error(`${label} is outside the BN254 scalar field.`);
  }
  return n;
}

function parseSolidityCalldata(raw) {
  const normalized = raw.trim().replace(/;$/, "");
  return JSON.parse(`[${normalized}]`);
}

function rewriteGeneratedVerifier(source, contractName, pairingName) {
  return source
    .replace(/\blibrary\s+Pairing\b/, `library ${pairingName}`)
    .replace(/\bPairing\./g, `${pairingName}.`)
    .replace(/\busing\s+Pairing\s+for\b/g, `using ${pairingName} for`)
    .replace(/\bcontract\s+Groth16Verifier\b/, `contract ${contractName}`);
}

module.exports = {
  bn254ScalarField,
  commandName,
  fieldHex,
  parseSolidityCalldata,
  profile,
  requireField,
  rewriteGeneratedVerifier,
  root,
  run,
  runCircom,
  runSnarkjs,
  splitBytes32,
};
