const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");

const root = path.resolve(__dirname, "..", "..");
const noirDir = path.join(root, "proof", "noir", "operation-authority");
const targetDir = path.join(noirDir, "target");
const artifact = path.join(targetDir, "operation_authority_noir.json");
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
    throw new Error("Usage: node scripts/proof/prove-operation-authority-noir.js <context.json>");
  }
  for (const required of [artifact, vkPath]) {
    if (!fs.existsSync(required)) {
      throw new Error(`Missing Noir proof artifact: ${required}. Run npm run proof:build:operation-authority first.`);
    }
  }

  const context = JSON.parse(fs.readFileSync(path.resolve(contextPath), "utf8"));
  const coprocessorSecret = requiredBigInt(
    context.coprocessorSecret ?? process.env.FHEBC_OPERATION_ZK_SECRET,
    "coprocessorSecret"
  );
  const operationDigest = context.operationDigest ?? process.env.FHEBC_OPERATION_DIGEST;
  if (!ethers.isHexString(operationDigest, 32)) {
    throw new Error("operationDigest must be a bytes32 hex string.");
  }
  const digestParts = splitBytes32(operationDigest);

  const label = (context.label ?? "operation").toString().replace(/[^a-zA-Z0-9_-]/g, "-");
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
      coprocessor_secret: coprocessorSecret.toString(),
      operation_digest_hi: digestParts.hi,
      operation_digest_lo: digestParts.lo
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
  if (publicInputs.length !== 4) {
    throw new Error(`Expected 4 Noir public inputs, got ${publicInputs.length}`);
  }
  const expectedDigestInputs = [fieldBytes32(digestParts.hi), fieldBytes32(digestParts.lo)];
  for (let i = 0; i < expectedDigestInputs.length; i++) {
    if (publicInputs[i].toLowerCase() !== expectedDigestInputs[i].toLowerCase()) {
      throw new Error(`Noir public input ${i} mismatch: ${publicInputs[i]} != ${expectedDigestInputs[i]}`);
    }
  }

  const authorityCommitment = publicInputs[2];
  const attestationHash = publicInputs[3];
  const proofBytes = ethers.hexlify(fs.readFileSync(proofPath));
  const proof = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "bytes", "bytes32[]"],
    [authorityCommitment, attestationHash, proofBytes, publicInputs]
  );

  const report = {
    context: path.resolve(contextPath),
    runDir,
    operationDigest,
    authorityCommitment,
    attestationHash,
    publicInputs,
    proof
  };
  fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ authorityCommitment, attestationHash, proof }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
