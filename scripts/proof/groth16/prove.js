const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const circomlibjs = require("circomlibjs");
const {
  fieldHex,
  parseSolidityCalldata,
  profile,
  requireField,
  root,
  run,
  runSnarkjs,
  splitBytes32,
} = require("./utils");

const profileName = process.argv[2];
const contextPath = process.argv[3];
if (!profileName || !contextPath) {
  throw new Error("Usage: node scripts/proof/groth16/prove.js <energy-input|operation-authority> <context.json>");
}

function requiredBigInt(value, name) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing ${name}`);
  }
  return BigInt(value);
}

async function poseidonHash(inputs) {
  const poseidon = await circomlibjs.buildPoseidon();
  return poseidon.F.toObject(poseidon(inputs.map((value) => BigInt(value))));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function proofFromCalldata(calldata) {
  const [a, b, c, publicSignals] = calldata;
  return { a, b, c, publicSignals };
}

async function proveEnergyInput(selected, context, runDir) {
  const plaintext = requiredBigInt(context.plaintext ?? process.env.FHEBC_ZK_PLAINTEXT, "plaintext");
  const salt = requiredBigInt(context.salt ?? process.env.FHEBC_ZK_SALT, "salt");
  const owner = BigInt(context.owner);
  const minValue = requiredBigInt(context.minValue, "minValue");
  const maxValue = requiredBigInt(context.maxValue, "maxValue");
  const ciphertextParts = splitBytes32(context.ciphertextHash);
  const metadataHash = await poseidonHash([plaintext, salt, owner, ciphertextParts.hi, ciphertextParts.lo]);
  requireField(metadataHash, "metadataHash");

  const input = {
    plaintext: plaintext.toString(),
    salt: salt.toString(),
    ciphertext_hash_hi: ciphertextParts.hi.toString(),
    ciphertext_hash_lo: ciphertextParts.lo.toString(),
    owner: owner.toString(),
    min_value: minValue.toString(),
    max_value: maxValue.toString(),
    metadata_hash: metadataHash.toString(),
  };

  const result = await runGroth16(selected, runDir, input);
  const expected = [
    ciphertextParts.hi,
    ciphertextParts.lo,
    owner,
    minValue,
    maxValue,
    metadataHash,
  ].map((value) => BigInt(value).toString());
  assertPublicSignals(result.publicSignals, expected);

  const proof = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "address",
      "bytes32",
      "bytes32",
      "uint256",
      "uint256",
      "bytes32",
      "uint256[2]",
      "uint256[2][2]",
      "uint256[2]",
      "uint256[6]",
    ],
    [
      context.owner,
      context.ciphertextHash,
      fieldHex(metadataHash),
      minValue,
      maxValue,
      context.nonce,
      result.a,
      result.b,
      result.c,
      result.publicSignals,
    ]
  );

  return {
    metadataHash: fieldHex(metadataHash),
    publicSignals: result.publicSignals.map(fieldHex),
    proof,
  };
}

async function proveOperationAuthority(selected, context, runDir) {
  const coprocessorSecret = requiredBigInt(
    context.coprocessorSecret ?? process.env.FHEBC_OPERATION_ZK_SECRET,
    "coprocessorSecret"
  );
  const operationDigest = context.operationDigest ?? process.env.FHEBC_OPERATION_DIGEST;
  if (!ethers.isHexString(operationDigest, 32)) {
    throw new Error("operationDigest must be a bytes32 hex string.");
  }
  const digestParts = splitBytes32(operationDigest);
  const authorityCommitment = await poseidonHash([coprocessorSecret]);
  const attestationHash = await poseidonHash([coprocessorSecret, digestParts.hi, digestParts.lo]);
  requireField(authorityCommitment, "authorityCommitment");
  requireField(attestationHash, "attestationHash");

  const input = {
    coprocessor_secret: coprocessorSecret.toString(),
    operation_digest_hi: digestParts.hi.toString(),
    operation_digest_lo: digestParts.lo.toString(),
    authority_commitment: authorityCommitment.toString(),
    attestation_hash: attestationHash.toString(),
  };

  const result = await runGroth16(selected, runDir, input);
  const expected = [
    digestParts.hi,
    digestParts.lo,
    authorityCommitment,
    attestationHash,
  ].map((value) => BigInt(value).toString());
  assertPublicSignals(result.publicSignals, expected);

  const proof = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "uint256[2]", "uint256[2][2]", "uint256[2]", "uint256[4]"],
    [fieldHex(authorityCommitment), fieldHex(attestationHash), result.a, result.b, result.c, result.publicSignals]
  );

  return {
    authorityCommitment: fieldHex(authorityCommitment),
    attestationHash: fieldHex(attestationHash),
    publicSignals: result.publicSignals.map(fieldHex),
    proof,
  };
}

async function runGroth16(selected, runDir, input) {
  for (const required of [selected.wasmPath, selected.witnessGeneratorPath, selected.zkeyFinalPath, selected.verificationKeyPath]) {
    if (!fs.existsSync(required)) {
      throw new Error(`Missing Groth16 artifact: ${required}. Run npm run proof:build:${profileName}:groth16 first.`);
    }
  }

  const inputPath = path.join(runDir, "input.json");
  const witnessPath = path.join(runDir, "witness.wtns");
  const proofPath = path.join(runDir, "proof.json");
  const publicPath = path.join(runDir, "public.json");
  writeJson(inputPath, input);

  run("node", [selected.witnessGeneratorPath, selected.wasmPath, inputPath, witnessPath], { stdio: "inherit" });
  runSnarkjs(
    [
      "groth16",
      "prove",
      path.relative(root, selected.zkeyFinalPath),
      path.relative(root, witnessPath),
      path.relative(root, proofPath),
      path.relative(root, publicPath),
    ],
    { stdio: "inherit" }
  );
  runSnarkjs(
    [
      "groth16",
      "verify",
      path.relative(root, selected.verificationKeyPath),
      path.relative(root, publicPath),
      path.relative(root, proofPath),
    ],
    { stdio: "inherit" }
  );
  const rawCalldata = runSnarkjs(
    ["zkey", "export", "soliditycalldata", path.relative(root, publicPath), path.relative(root, proofPath)],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  return proofFromCalldata(parseSolidityCalldata(rawCalldata));
}

function assertPublicSignals(actual, expected) {
  if (actual.length !== expected.length) {
    throw new Error(`Expected ${expected.length} public signals, got ${actual.length}.`);
  }
  for (let i = 0; i < expected.length; i++) {
    if (BigInt(actual[i]).toString() !== BigInt(expected[i]).toString()) {
      throw new Error(`Groth16 public signal ${i} mismatch: ${actual[i]} != ${expected[i]}`);
    }
  }
}

async function main() {
  const selected = profile(profileName);
  const context = JSON.parse(fs.readFileSync(path.resolve(contextPath), "utf8"));
  const label = (context.label ?? profileName).toString().replace(/[^a-zA-Z0-9_-]/g, "-");
  const runDir = path.join(selected.targetDir, "runs", `${Date.now()}-${label}`);
  fs.mkdirSync(runDir, { recursive: true });

  const report =
    profileName === "energy-input"
      ? await proveEnergyInput(selected, context, runDir)
      : await proveOperationAuthority(selected, context, runDir);

  const fullReport = { context: path.resolve(contextPath), runDir, ...report };
  writeJson(path.join(runDir, "report.json"), fullReport);
  console.log(JSON.stringify(report));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
