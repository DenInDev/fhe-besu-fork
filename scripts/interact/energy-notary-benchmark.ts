import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { artifacts, ethers } from "hardhat";
import {
  decryptU32,
  dispatchMaxU32,
  dispatchMeanU32,
  encryptU32,
  ensureKeys,
  ensureParent,
  projectPath,
  readCiphertextHex
} from "../lib/runtime";
import {
  OperationKind,
  binaryInputSetHash,
  ensureOperationProofVerifier,
  proveOperationProof
} from "../lib/operation-proof";

const FHE_PRECOMPILE_ADDRESS = "0x0000000000000000000000000000000000000100";
const BN254_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

type TxOverrides = {
  gasLimit: bigint;
  gasPrice: bigint;
};

type Stat = {
  label: string;
  kind: "tx" | "view" | "decrypt";
  gasUsed: string;
  latencyMs: number;
  clearValue?: number;
};

function hexToBuffer(hex: string) {
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

function bufferToHex(buffer: Buffer) {
  return ethers.hexlify(buffer);
}

function fieldSalt(seed: string) {
  return (BigInt(ethers.keccak256(ethers.toUtf8Bytes(seed))) % BN254_SCALAR_FIELD).toString();
}

function parseLastJsonLine(output: string) {
  const line = output.split(/\r?\n/).filter(Boolean).pop();
  if (!line) {
    throw new Error("Proof command produced no output.");
  }
  return JSON.parse(line);
}

function runInputProofCommand(contextPath: string) {
  const command = process.env.FHEBC_ZK_PROOF_COMMAND ?? "node scripts/proof/prove-energy-input-noir.js";
  const output = execSync(`${command} ${JSON.stringify(contextPath)}`, {
    cwd: projectPath(),
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const parsed = parseLastJsonLine(output);
  if (!ethers.isHexString(parsed.proof)) {
    throw new Error("Proof command JSON must contain a hex `proof` field.");
  }
  if (!ethers.isHexString(parsed.metadataHash, 32)) {
    throw new Error("Proof command JSON must contain a bytes32 `metadataHash` field.");
  }
  return parsed as { metadataHash: string; proof: string };
}

async function deployGeneratedNoirVerifier(txOverrides: TxOverrides) {
  if (!(await artifacts.artifactExists("NoirEnergyInputGeneratedVerifier"))) {
    throw new Error(
      "No input verifier configured. Set FHEBC_INPUT_PROOF_VERIFIER_ADDRESS or FHEBC_NOIR_INPUT_VERIFIER_ADDRESS, " +
        "or build the Noir verifier with `npm run proof:build:energy-input` and recompile."
    );
  }

  const TranscriptLib = await ethers.getContractFactory("ZKTranscriptLib");
  const transcriptLib = await TranscriptLib.deploy(txOverrides);
  await transcriptLib.waitForDeployment();

  const Verifier = await ethers.getContractFactory("NoirEnergyInputGeneratedVerifier", {
    libraries: { ZKTranscriptLib: await transcriptLib.getAddress() }
  });
  const verifier = await Verifier.deploy(txOverrides);
  await verifier.waitForDeployment();
  return verifier.getAddress();
}

async function deployOrResolveInputProofVerifier(txOverrides: TxOverrides) {
  if (process.env.FHEBC_INPUT_PROOF_VERIFIER_ADDRESS) {
    return process.env.FHEBC_INPUT_PROOF_VERIFIER_ADDRESS;
  }

  const generatedVerifier = process.env.FHEBC_NOIR_INPUT_VERIFIER_ADDRESS ?? await deployGeneratedNoirVerifier(txOverrides);
  const Adapter = await ethers.getContractFactory("NoirEnergyInputVerifierAdapter");
  const adapter = await Adapter.deploy(generatedVerifier, txOverrides);
  await adapter.waitForDeployment();
  if (process.env.FHEBC_FREEZE_INPUT_PROOF_ADAPTER !== "0") {
    await (await adapter.freezeConfiguration(txOverrides)).wait();
  }
  return adapter.getAddress();
}

async function deployOrAttachNotary(txOverrides: TxOverrides) {
  const explicitAddress = process.env.FHEBC_NOTARY_ADDRESS ?? process.env.NOTARY_ADDRESS;
  if (explicitAddress) {
    return ethers.getContractAt("EnergyDataNotaryOnChain", explicitAddress);
  }

  if (process.env.FHEBC_DEPLOYMENT_MANIFEST && fs.existsSync(path.resolve(process.env.FHEBC_DEPLOYMENT_MANIFEST))) {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(process.env.FHEBC_DEPLOYMENT_MANIFEST), "utf8"));
    return ethers.getContractAt("EnergyDataNotaryOnChain", manifest.addresses.energyDataNotary);
  }

  const verifierAddress = await deployOrResolveInputProofVerifier(txOverrides);
  const Notary = await ethers.getContractFactory("EnergyDataNotaryOnChain");
  const notary = await Notary.deploy(txOverrides);
  await notary.waitForDeployment();
  await (await notary.setInputProofVerifier(verifierAddress, txOverrides)).wait();
  if (process.env.FHEBC_FREEZE_INPUT_PROOF_CONFIG !== "0") {
    await (await notary.freezeInputProofConfiguration(txOverrides)).wait();
  }
  return notary;
}

async function ensureNotaryVerifier(notary: any, txOverrides: TxOverrides) {
  const currentVerifier = await notary.inputProofVerifier();
  if (currentVerifier !== ethers.ZeroAddress) {
    return currentVerifier;
  }
  if (await notary.inputProofConfigurationFrozen()) {
    throw new Error("Notary input proof configuration is frozen without a verifier.");
  }
  const verifierAddress = await deployOrResolveInputProofVerifier(txOverrides);
  await (await notary.setInputProofVerifier(verifierAddress, txOverrides)).wait();
  if (process.env.FHEBC_FREEZE_INPUT_PROOF_CONFIG !== "0") {
    await (await notary.freezeInputProofConfiguration(txOverrides)).wait();
  }
  return verifierAddress;
}

async function measureTx(label: string, stats: Stat[], fn: () => Promise<any>) {
  const started = Date.now();
  const tx = await fn();
  const receipt = await tx.wait();
  const latencyMs = Date.now() - started;
  const gasUsed = (receipt?.gasUsed ?? 0n).toString();
  stats.push({ label, kind: "tx", gasUsed, latencyMs });
  console.log(`${label.padEnd(34)} gas=${BigInt(gasUsed).toLocaleString().padStart(12)} latency=${latencyMs} ms`);
  return receipt;
}

async function measureView(label: string, stats: Stat[], fn: () => Promise<any>) {
  const started = Date.now();
  const result = await fn();
  const latencyMs = Date.now() - started;
  stats.push({ label, kind: "view", gasUsed: "0", latencyMs });
  console.log(`${label.padEnd(34)} gas=${"(view)".padStart(12)} latency=${latencyMs} ms`);
  return result;
}

function decryptHex(label: string, stats: Stat[], clientKey: string, serverKey: string, outFile: string, ciphertextHex: string) {
  ensureParent(outFile);
  fs.writeFileSync(outFile, hexToBuffer(ciphertextHex));
  const started = Date.now();
  const clearValue = decryptU32(clientKey, outFile, serverKey);
  const latencyMs = Date.now() - started;
  stats.push({ label, kind: "decrypt", gasUsed: "0", latencyMs, clearValue });
  console.log(`${label.padEnd(34)} clear=${String(clearValue).padStart(8)} latency=${latencyMs} ms`);
  return clearValue;
}

async function prepareEncryptedInput(
  notary: any,
  owner: string,
  runDir: string,
  label: string,
  plaintext: number,
  minValue: number,
  maxValue: number,
  clientKey: string
) {
  const ciphertextPath = path.join(runDir, `${label}.ct`);
  encryptU32(clientKey, plaintext, ciphertextPath);
  const ciphertext = fs.readFileSync(ciphertextPath);
  const ciphertextHex = bufferToHex(ciphertext);
  const ciphertextHash = ethers.keccak256(ciphertextHex);
  const nonce = ethers.keccak256(ethers.toUtf8Bytes(`${Date.now()}:${label}:${owner}:${ciphertextHash}`));
  const contextPath = path.join(runDir, `${label}-input-proof-context.json`);
  const context = {
    label,
    owner,
    ciphertextHash,
    minValue: minValue.toString(),
    maxValue: maxValue.toString(),
    nonce,
    plaintext: plaintext.toString(),
    salt: fieldSalt(`${label}:${owner}:${ciphertextHash}`)
  };
  fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));
  const proofResult = runInputProofCommand(contextPath);
  const digest = await notary.inputProofDigestForCiphertext(
    owner,
    ciphertextHash,
    proofResult.metadataHash,
    minValue,
    maxValue,
    nonce
  );

  return {
    ciphertextHex,
    ciphertextPath,
    metadataHash: proofResult.metadataHash,
    minValue,
    maxValue,
    nonce,
    proof: proofResult.proof,
    digest
  };
}

async function main() {
  const [owner] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const gasPrice = BigInt(process.env.FHEBC_BESU_GAS_PRICE_WEI ?? "1000");
  const txOverrides = {
    gasLimit: BigInt(process.env.FHEBC_TX_GAS_LIMIT ?? "30000000"),
    gasPrice
  };
  const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const runDir = path.resolve(process.env.FHEBC_RUN_DIR ?? path.join("runtime", "runs", `energy-notary-${runId}`));
  const clientKey = path.resolve(process.env.FHEBC_TFHE_CLIENT_KEY_PATH ?? projectPath("runtime", "keys", "client.key"));
  const serverKey = path.resolve(process.env.FHEBC_TFHE_SERVER_KEY_PATH ?? projectPath("runtime", "keys", "server.key"));
  const stats: Stat[] = [];

  fs.mkdirSync(runDir, { recursive: true });
  ensureKeys(clientKey, serverKey);

  const smoke = await ethers.provider.call({ to: FHE_PRECOMPILE_ADDRESS, data: "0x" });
  if (smoke !== "0x0100000000000000") {
    throw new Error(`FHE precompile not available at ${FHE_PRECOMPILE_ADDRESS}; got ${smoke}`);
  }

  const notary = await deployOrAttachNotary(txOverrides);
  const notaryAddress = await notary.getAddress();
  const verifierAddress = await ensureNotaryVerifier(notary, txOverrides);
  const operationVerifierAddress = await ensureOperationProofVerifier(notary, txOverrides);

  console.log("=".repeat(90));
  console.log("BesuFHE EnergyDataNotary deterministic benchmark");
  console.log("=".repeat(90));
  console.log(`Network       : ${network.name} (chainId ${network.chainId})`);
  console.log(`Owner         : ${owner.address}`);
  console.log(`Notary        : ${notaryAddress}`);
  console.log(`Input verifier: ${verifierAddress}`);
  console.log(`Operation verifier: ${operationVerifierAddress}`);
  console.log(`Run dir       : ${runDir}`);
  console.log("=".repeat(90));

  const initialTotal = Number(process.env.FHEBC_INITIAL_TOTAL ?? "10");
  const entryValue = Number(process.env.FHEBC_ENTRY_VALUE ?? "42");
  const scalar = BigInt(process.env.FHEBC_SCALAR ?? "3");

  const totalInput = await prepareEncryptedInput(
    notary,
    owner.address,
    runDir,
    "initial-total",
    initialTotal,
    initialTotal,
    initialTotal,
    clientKey
  );
  await measureTx("initializeEncryptedTotal", stats, () =>
    notary.initializeEncryptedTotal(
      totalInput.ciphertextHex,
      totalInput.metadataHash,
      totalInput.minValue,
      totalInput.maxValue,
      totalInput.nonce,
      totalInput.proof,
      txOverrides
    )
  );

  const entryInput = await prepareEncryptedInput(
    notary,
    owner.address,
    runDir,
    "energy-entry",
    entryValue,
    0,
    Math.max(1_000_000, entryValue),
    clientKey
  );
  await measureTx("addEnergyEntry", stats, () =>
    notary.addEnergyEntry(
      entryInput.ciphertextHex,
      entryInput.metadataHash,
      entryInput.minValue,
      entryInput.maxValue,
      entryInput.nonce,
      entryInput.proof,
      txOverrides
    )
  );

  const previewAdd = await measureView("previewAddLastEntryToTotal", stats, () =>
    notary.previewAddLastEntryToEncryptedTotal()
  );
  decryptHex("decrypt preview add", stats, clientKey, serverKey, path.join(runDir, "preview-add.ct"), previewAdd);

  await measureTx("addLastEntryToEncryptedTotal", stats, () =>
    notary.addLastEntryToEncryptedTotal(txOverrides)
  );
  const addOutput = await notary.getEncryptedTotal();
  const addOutputPath = path.join(runDir, "native-add.ct");
  fs.writeFileSync(addOutputPath, hexToBuffer(addOutput));
  decryptHex(
    "decrypt encrypted total",
    stats,
    clientKey,
    serverKey,
    path.join(runDir, "encrypted-total.ct"),
    await notary.getEncryptedTotal()
  );

  const previewMul = await measureView("previewMultiplyLastEntry", stats, () =>
    notary.previewMultiplyLastEntryByConstant(scalar)
  );
  decryptHex("decrypt preview mul", stats, clientKey, serverKey, path.join(runDir, "preview-mul.ct"), previewMul);

  await measureTx("multiplyLastEntryByConstant", stats, () =>
    notary.multiplyLastEntryByConstant(scalar, txOverrides)
  );
  decryptHex(
    "decrypt mul result",
    stats,
    clientKey,
    serverKey,
    path.join(runDir, "mul-result.ct"),
    await notary.getLastResult()
  );

  const previewMean = await measureView("previewMeanLastEntryAndTotal", stats, () =>
    notary.previewMeanLastEntryAndEncryptedTotal()
  );
  decryptHex("decrypt preview mean", stats, clientKey, serverKey, path.join(runDir, "preview-mean.ct"), previewMean);

  const meanOutputPath = path.join(runDir, "proof-mean.ct");
  dispatchMeanU32(serverKey, meanOutputPath, [entryInput.ciphertextPath, addOutputPath]);
  const meanOutput = readCiphertextHex(meanOutputPath);
  const aggregateInputSetHash = binaryInputSetHash(entryInput.ciphertextHex, addOutput);
  const meanProof = await proveOperationProof(
    notary,
    owner.address,
    OperationKind.Mean,
    aggregateInputSetHash,
    meanOutput,
    "meanLastEntryAndEncryptedTotal"
  );
  await measureTx("meanLastEntryAndEncryptedTotal", stats, () =>
    notary.meanLastEntryAndEncryptedTotalProof(meanOutput, meanProof.nonce, meanProof.proof, txOverrides)
  );
  decryptHex(
    "decrypt mean result",
    stats,
    clientKey,
    serverKey,
    path.join(runDir, "mean-result.ct"),
    await notary.getLastResult()
  );

  const previewMax = await measureView("previewMaxLastEntryAndTotal", stats, () =>
    notary.previewMaxLastEntryAndEncryptedTotal()
  );
  decryptHex("decrypt preview max", stats, clientKey, serverKey, path.join(runDir, "preview-max.ct"), previewMax);

  const maxOutputPath = path.join(runDir, "proof-max.ct");
  dispatchMaxU32(serverKey, maxOutputPath, [entryInput.ciphertextPath, addOutputPath]);
  const maxOutput = readCiphertextHex(maxOutputPath);
  const maxProof = await proveOperationProof(
    notary,
    owner.address,
    OperationKind.Max,
    aggregateInputSetHash,
    maxOutput,
    "maxLastEntryAndEncryptedTotal"
  );
  await measureTx("maxLastEntryAndEncryptedTotal", stats, () =>
    notary.maxLastEntryAndEncryptedTotalProof(maxOutput, maxProof.nonce, maxProof.proof, txOverrides)
  );
  decryptHex(
    "decrypt max result",
    stats,
    clientKey,
    serverKey,
    path.join(runDir, "max-result.ct"),
    await notary.getLastResult()
  );

  const report = {
    generatedAt: new Date().toISOString(),
    network: { name: network.name, chainId: network.chainId.toString() },
    owner: owner.address,
    notary: notaryAddress,
    verifier: verifierAddress,
    operationVerifier: operationVerifierAddress,
    runDir,
    inputs: { initialTotal, entryValue, scalar: scalar.toString() },
    stats
  };
  fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));

  console.log("=".repeat(90));
  console.log(`JSON report: ${path.join(runDir, "report.json")}`);
  console.log("=".repeat(90));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
