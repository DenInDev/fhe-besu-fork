const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");

const root = path.resolve(__dirname, "..", "..");
const noirDir = path.join(root, "proof", "noir", "energy-input");
const targetDir = path.join(noirDir, "target");
const artifact = path.join(targetDir, "energy_input_validation_noir.json");
const vkPath = path.join(targetDir, "vk");
const oracleHash = process.env.FHEBC_NOIR_ORACLE_HASH ?? "keccak";
const useWslDocker = process.env.FHEBC_NOIR_RUNNER === "wsl-docker" || process.platform === "win32";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
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
  return execFileSync("wsl", ["bash", "-lc", script], {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    env: process.env
  });
}

function runBb(args) {
  if (!useWslDocker) {
    return run("bb", args, { stdio: "inherit" });
  }
  const rootWsl = wslPath(root);
  const command = [
    "set -e",
    `cd ${shellQuote(rootWsl)}`,
    `docker run --rm -v "$HOME/.bb:/bb" -v "$PWD:/work" -w /work ubuntu:24.04 /bb/bb ${args.map(shellQuote).join(" ")}`
  ].join("; ");
  return runWsl(command);
}

function requiredBigInt(value, name) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing ${name}`);
  }
  return BigInt(value);
}

function splitBytes32(value) {
  const n = BigInt(value);
  return {
    hi: (n >> 128n).toString(),
    lo: (n & ((1n << 128n) - 1n)).toString()
  };
}

function fieldBytes32(value) {
  return ethers.toBeHex(BigInt(value), 32);
}

function readFieldFile(filePath) {
  const raw = fs.readFileSync(filePath);
  const fields = [];
  for (let offset = 0; offset < raw.length; offset += 32) {
    const chunk = raw.subarray(offset, offset + 32);
    if (chunk.length === 32) {
      fields.push(ethers.hexlify(chunk));
    }
  }
  return fields;
}

function writeToml(filePath, input) {
  const lines = Object.entries(input).map(([key, value]) => `${key} = "${value}"`);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

async function main() {
  const contextPath = process.argv[2];
  if (!contextPath) {
    throw new Error("Usage: node scripts/proof/prove-energy-input-noir.js <context.json>");
  }
  for (const required of [artifact, vkPath]) {
    if (!fs.existsSync(required)) {
      throw new Error(`Missing Noir proof artifact: ${required}. Run npm run proof:build:energy-input:noir first.`);
    }
  }

  const context = JSON.parse(fs.readFileSync(path.resolve(contextPath), "utf8"));
  const plaintext = requiredBigInt(context.plaintext ?? process.env.FHEBC_ZK_PLAINTEXT, "plaintext");
  const salt = requiredBigInt(context.salt ?? process.env.FHEBC_ZK_SALT, "salt");
  const ciphertextParts = splitBytes32(context.ciphertextHash);
  const owner = BigInt(context.owner);
  const minValue = requiredBigInt(context.minValue, "minValue");
  const maxValue = requiredBigInt(context.maxValue, "maxValue");

  const label = (context.label ?? "input").toString().replace(/[^a-zA-Z0-9_-]/g, "-");
  const runDir = path.join(targetDir, "runs", `${Date.now()}-${label}`);
  fs.mkdirSync(runDir, { recursive: true });

  const proverToml = path.join(noirDir, "Prover.toml");
  const backupToml = fs.existsSync(proverToml) ? fs.readFileSync(proverToml) : null;
  const witnessName = `witness-${Date.now()}-${label}`;
  let witnessPath = path.join(targetDir, `${witnessName}.gz`);
  const proofPath = path.join(runDir, "proof");
  const publicInputsPath = path.join(runDir, "public_inputs");

  try {
    writeToml(proverToml, {
      plaintext: plaintext.toString(),
      salt: salt.toString(),
      ciphertext_hash_hi: ciphertextParts.hi,
      ciphertext_hash_lo: ciphertextParts.lo,
      owner: owner.toString(),
      min_value: minValue.toString(),
      max_value: maxValue.toString()
    });

    if (useWslDocker) {
      const noirDirWsl = wslPath(noirDir);
      runWsl(
        `set -e; export PATH="$HOME/.nargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"; cd ${shellQuote(
          noirDirWsl
        )}; nargo execute ${shellQuote(witnessName)}`
      );
    } else {
      run("nargo", ["execute", witnessName], { cwd: noirDir, stdio: "inherit" });
    }
    if (!fs.existsSync(witnessPath)) {
      const fallbackWitnessPath = path.join(targetDir, witnessName);
      if (!fs.existsSync(fallbackWitnessPath)) {
        throw new Error(`Noir witness not found: ${witnessPath} or ${fallbackWitnessPath}`);
      }
      witnessPath = fallbackWitnessPath;
    }

    runBb([
      "prove",
      "-b",
      path.relative(root, artifact).replace(/\\/g, "/"),
      "-w",
      path.relative(root, witnessPath).replace(/\\/g, "/"),
      "-k",
      path.relative(root, vkPath).replace(/\\/g, "/"),
      "-o",
      path.relative(root, runDir).replace(/\\/g, "/"),
      "--oracle_hash",
      oracleHash
    ]);
    runBb([
      "verify",
      "-k",
      path.relative(root, vkPath).replace(/\\/g, "/"),
      "-p",
      path.relative(root, proofPath).replace(/\\/g, "/"),
      "-i",
      path.relative(root, publicInputsPath).replace(/\\/g, "/"),
      "--oracle_hash",
      oracleHash
    ]);
  } finally {
    if (backupToml) {
      fs.writeFileSync(proverToml, backupToml);
    } else if (fs.existsSync(proverToml)) {
      fs.rmSync(proverToml);
    }
  }

  if (!fs.existsSync(proofPath) || !fs.existsSync(publicInputsPath)) {
    throw new Error(`Barretenberg proof output missing in ${runDir}`);
  }

  const publicInputs = readFieldFile(publicInputsPath);
  if (publicInputs.length !== 6) {
    throw new Error(`Expected 6 Noir public inputs, got ${publicInputs.length}`);
  }

  const expectedPublicInputs = [
    fieldBytes32(ciphertextParts.hi),
    fieldBytes32(ciphertextParts.lo),
    fieldBytes32(owner),
    fieldBytes32(minValue),
    fieldBytes32(maxValue)
  ];
  for (let i = 0; i < expectedPublicInputs.length; i++) {
    if (publicInputs[i].toLowerCase() !== expectedPublicInputs[i].toLowerCase()) {
      throw new Error(`Noir public input ${i} mismatch: ${publicInputs[i]} != ${expectedPublicInputs[i]}`);
    }
  }

  const metadataHash = publicInputs[5];
  const proofBytes = ethers.hexlify(fs.readFileSync(proofPath));
  const proof = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes32", "bytes32", "uint256", "uint256", "bytes32", "bytes", "bytes32[]"],
    [
      context.owner,
      context.ciphertextHash,
      metadataHash,
      minValue,
      maxValue,
      context.nonce,
      proofBytes,
      publicInputs
    ]
  );

  const report = {
    context: path.resolve(contextPath),
    runDir,
    ciphertextHash: ethers.toBeHex(BigInt(context.ciphertextHash), 32),
    metadataHash,
    publicInputs,
    proof
  };
  fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ metadataHash, proof }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
