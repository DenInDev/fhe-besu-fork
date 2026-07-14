import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { artifacts, ethers } from "hardhat";
import {
  decryptU32,
  dispatchAddU32,
  dispatchMaxU32,
  dispatchMeanU32,
  dispatchMulScalarU32,
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
  proveOperationProof,
  scalarInputSetHash
} from "../lib/operation-proof";

const FHE_PRECOMPILE_ADDRESS = "0x0000000000000000000000000000000000000100";
const BN254_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

type TxOverrides = {
  gasLimit: bigint;
  gasPrice: bigint;
};

type Sample = {
  operation: string;
  kind: "tx" | "view" | "decrypt";
  gasUsed: number;
  latencyMs: number;
  clearValue?: number;
};

type PreparedInput = {
  ciphertextHex: string;
  ciphertextPath: string;
  metadataHash: string;
  minValue: number;
  maxValue: number;
  nonce: string;
  proof: string;
};

type OperationProofContext =
  | { mode: "groth16"; verifierAddress: string; adapter?: never; mockVerifier?: never }
  | { mode: "mock"; verifierAddress: string; adapter: any; mockVerifier: any };

type InputProofContext =
  | { mode: "groth16"; verifierAddress: string; adapter: any; mockVerifier?: never }
  | { mode: "mock"; verifierAddress: string; adapter: any; mockVerifier: any };

type TxSigner = any;

function hexToBuffer(hex: string) {
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

function bufferToHex(buffer: Buffer) {
  return ethers.hexlify(buffer);
}

function fieldSafeBytes32(seed: string) {
  return ethers.toBeHex(BigInt(ethers.keccak256(ethers.toUtf8Bytes(seed))) % BN254_SCALAR_FIELD, 32);
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
  const defaultCommand = "node scripts/proof/groth16/prove-energy-input.js";
  const command = process.env.FHEBC_ZK_PROOF_COMMAND ?? defaultCommand;
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

function avg(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStd(values: number[]) {
  if (values.length < 2) return 0;
  const mean = avg(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function round(value: number, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatNumber(value: number, digits = 0) {
  return round(value, digits).toLocaleString("it-IT", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function parseBenchmarkOperations() {
  const raw = process.env.FHEBC_BENCHMARK_OPS ?? process.env.FHEBC_BENCHMARK_ONLY ?? "all";
  const values = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0 || values.includes("all")) {
    return null;
  }
  return new Set(values);
}

function summarize(samples: Sample[]) {
  const order = [
    "notarize",
    "decrypt",
    "add_view",
    "add",
    "mul_scalar",
    "mean_view",
    "mean",
    "max_view",
    "max"
  ];

  return order
    .map((operation) => {
      const values = samples.filter((sample) => sample.operation === operation);
      const gas = values.map((sample) => sample.gasUsed);
      const latency = values.map((sample) => sample.latencyMs);
      const meanGas = avg(gas);
      const meanLatency = avg(latency);
      const latencyStd = sampleStd(latency);
      return {
        operation,
        n: values.length,
        meanGas,
        meanLatency,
        latencyStdPct: meanLatency === 0 ? 0 : (latencyStd / meanLatency) * 100
      };
    })
    .filter((row) => row.n > 0);
}

function markdownTable(rows: ReturnType<typeof summarize>, mode: string, gasPriceWei: bigint, allProofBacked: boolean) {
  const lines = [
    "# Benchmark BesuFHE",
    "",
    `Modalita': ${mode}`,
    `Gas price: ${gasPriceWei.toString()} wei`,
    "",
    "| Operazione | n | Gas medio | Latenza media (ms) | Dev. std latenza (%) |",
    "|---|---:|---:|---:|---:|"
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.operation} | ${row.n} | ${formatNumber(row.meanGas)} | ${formatNumber(row.meanLatency)} | ${formatNumber(
        row.latencyStdPct,
        2
      )} |`
    );
  }
  lines.push(
    "",
    allProofBacked
      ? "Nota: le tx `add`, `mul_scalar`, `mean` e `max` usano il flusso proof-backed ZK configurato per evitare output FHE non deterministici tra validator. Le view restano chiamate native alla precompile su un singolo nodo."
      : "Nota: `add` e `mul_scalar` sono eseguite nativamente dalla precompile BesuFHE; `mean` e `max` usano il flusso proof-backed ZK configurato. Le view restano chiamate native alla precompile e non aggiornano lo storage."
  );
  return `${lines.join("\n")}\n`;
}

function latexTable(rows: ReturnType<typeof summarize>, mode: string, gasPriceWei: bigint, allProofBacked: boolean) {
  const body = rows
    .map(
      (row) =>
        `${row.operation.replace(/_/g, "\\_")} & ${row.n} & ${formatNumber(row.meanGas)} & ${formatNumber(
          row.meanLatency
        )} & ${formatNumber(row.latencyStdPct, 2)} \\\\`
    )
    .join("\n");

  return [
    "\\begin{table}[H]",
    "\\centering",
    "\\caption{Benchmark BesuFHE su chain Besu locale}",
    "\\label{tab:besufhe-local-benchmark}",
    "\\begin{tabular}{lrrrr}",
    "\\hline",
    "\\textbf{Operazione} & \\textbf{n} & \\textbf{Gas medio} & \\textbf{Latenza media (ms)} & \\textbf{Dev. std latenza (\\%)} \\\\",
    "\\hline",
    body,
    "\\hline",
    "\\end{tabular}",
    "\\end{table}",
    "\\vspace{4pt}",
    "",
    `% Modalita': ${mode}. Gas price rilevato: ${gasPriceWei.toString()} wei.`,
    allProofBacked
      ? "% Nota: operazioni tx proof-backed per evitare output FHE non deterministici tra validator; view native su singolo nodo."
      : "% Nota: add e mul_scalar native su precompile BesuFHE; mean e max proof-backed ZK; view native senza aggiornamento di storage."
  ].join("\n");
}

async function measureTx(operation: string, samples: Sample[], fn: () => Promise<any>) {
  const started = Date.now();
  const tx = await fn();
  const receipt = await tx.wait();
  const latencyMs = Date.now() - started;
  const gasUsed = Number(receipt?.gasUsed ?? 0n);
  samples.push({ operation, kind: "tx", gasUsed, latencyMs });
  console.log(`${operation.padEnd(14)} tx      gas=${gasUsed.toLocaleString().padStart(12)} latency=${latencyMs} ms`);
  return receipt;
}

async function measureView(operation: string, samples: Sample[], fn: () => Promise<any>) {
  const started = Date.now();
  const result = await fn();
  const latencyMs = Date.now() - started;
  samples.push({ operation, kind: "view", gasUsed: 0, latencyMs });
  console.log(`${operation.padEnd(14)} view    gas=${"(view)".padStart(12)} latency=${latencyMs} ms`);
  return result;
}

function measureDecrypt(
  operation: string,
  samples: Sample[],
  clientKey: string,
  serverKey: string,
  outFile: string,
  ciphertextHex: string
) {
  ensureParent(outFile);
  fs.writeFileSync(outFile, hexToBuffer(ciphertextHex));
  const started = Date.now();
  const clearValue = decryptU32(clientKey, outFile, serverKey);
  const latencyMs = Date.now() - started;
  samples.push({ operation, kind: "decrypt", gasUsed: 0, latencyMs, clearValue });
  console.log(`${operation.padEnd(14)} decrypt clear=${String(clearValue).padStart(8)} latency=${latencyMs} ms`);
  return clearValue;
}

async function setMockPublicInputs(
  adapter: any,
  mockVerifier: any,
  owner: string,
  ciphertextHash: string,
  metadataHash: string,
  minValue: number,
  maxValue: number,
  txOverrides: TxOverrides
) {
  const rawPublicInputs = await adapter.publicSignals(owner, ciphertextHash, metadataHash, minValue, maxValue);
  await (await mockVerifier.setExpectedPublicSignals(Array.from(rawPublicInputs), txOverrides)).wait();
}

async function prepareInput(
  notary: any,
  inputProofContext: InputProofContext,
  owner: string,
  runDir: string,
  label: string,
  value: number,
  minValue: number,
  maxValue: number,
  clientKey: string,
  txOverrides: TxOverrides
): Promise<PreparedInput> {
  const ciphertextPath = path.join(runDir, `${label}.ct`);
  encryptU32(clientKey, value, ciphertextPath);
  const ciphertextHex = bufferToHex(fs.readFileSync(ciphertextPath));
  const ciphertextHash = ethers.keccak256(ciphertextHex);
  const nonce = ethers.keccak256(ethers.toUtf8Bytes(`${Date.now()}:${label}:${owner}:${ciphertextHash}`));

  let metadataHash: string;
  let proof: string;

  if (inputProofContext.mode === "groth16") {
    const contextPath = path.join(runDir, `${label}-input-proof-context.json`);
    const context = {
      label,
      owner,
      ciphertextHash,
      minValue: minValue.toString(),
      maxValue: maxValue.toString(),
      nonce,
      plaintext: value.toString(),
      salt: fieldSalt(`${label}:${owner}:${ciphertextHash}`)
    };
    fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));
    const proofResult = runInputProofCommand(contextPath);
    metadataHash = proofResult.metadataHash;
    proof = proofResult.proof;
  } else {
    metadataHash = fieldSafeBytes32(`metadata:${label}:${value}`);
    await setMockPublicInputs(
      inputProofContext.adapter,
      inputProofContext.mockVerifier,
      owner,
      ciphertextHash,
      metadataHash,
      minValue,
      maxValue,
      txOverrides
    );

    proof = ethers.AbiCoder.defaultAbiCoder().encode(
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
        "uint256[6]"
      ],
      [
        owner,
        ciphertextHash,
        metadataHash,
        minValue,
        maxValue,
        nonce,
        [0, 0],
        [
          [0, 0],
          [0, 0]
        ],
        [0, 0],
        await inputProofContext.adapter.publicSignals(owner, ciphertextHash, metadataHash, minValue, maxValue)
      ]
    );
  }

  await notary.inputProofDigestForCiphertext(owner, ciphertextHash, metadataHash, minValue, maxValue, nonce);

  return { ciphertextHex, ciphertextPath, metadataHash, minValue, maxValue, nonce, proof };
}

async function addInput(
  notary: any,
  prepared: PreparedInput,
  txOverrides: TxOverrides,
  measured: boolean,
  samples: Sample[]
) {
  const call = () =>
    notary.addEnergyEntry(
      prepared.ciphertextHex,
      prepared.metadataHash,
      prepared.minValue,
      prepared.maxValue,
      prepared.nonce,
      prepared.proof,
      txOverrides
    );
  if (measured) {
    return measureTx("notarize", samples, call);
  }
  return (await call()).wait();
}

async function initializeTotal(notary: any, prepared: PreparedInput, txOverrides: TxOverrides) {
  return (
    await notary.initializeEncryptedTotal(
      prepared.ciphertextHex,
      prepared.metadataHash,
      prepared.minValue,
      prepared.maxValue,
      prepared.nonce,
      prepared.proof,
      txOverrides
    )
  ).wait();
}

async function deployGeneratedGroth16InputVerifier(txOverrides: TxOverrides, signer: TxSigner) {
  if (!(await artifacts.artifactExists("Groth16EnergyInputGeneratedVerifier"))) {
    throw new Error(
      "Groth16EnergyInputGeneratedVerifier missing. Run `npm run proof:build:energy-input:groth16` and then `npm run compile`."
    );
  }

  const Verifier = await ethers.getContractFactory("Groth16EnergyInputGeneratedVerifier", signer);
  const verifier = await Verifier.deploy(txOverrides);
  await verifier.waitForDeployment();
  return verifier.getAddress();
}

async function setupInputProofContext(txOverrides: TxOverrides, signer: TxSigner): Promise<InputProofContext> {
  const requestedMode = (process.env.FHEBC_BENCHMARK_INPUT_PROOF_MODE ?? "mock").toLowerCase();
  const mode = requestedMode === "real" ? "groth16" : requestedMode;

  if (mode === "groth16") {
    const generatedVerifier =
      process.env.FHEBC_GROTH16_INPUT_VERIFIER_ADDRESS ?? (await deployGeneratedGroth16InputVerifier(txOverrides, signer));
    const Adapter = await ethers.getContractFactory("Groth16EnergyInputVerifierAdapter", signer);
    const adapter = await Adapter.deploy(generatedVerifier, txOverrides);
    await adapter.waitForDeployment();
    return { mode: "groth16", verifierAddress: await adapter.getAddress(), adapter };
  }

  if (mode !== "mock") {
    throw new Error(`Invalid FHEBC_BENCHMARK_INPUT_PROOF_MODE: ${mode}`);
  }

  const MockVerifier = await ethers.getContractFactory("MockGroth16EnergyInputVerifier", signer);
  const mockVerifier = await MockVerifier.deploy(true, txOverrides);
  await mockVerifier.waitForDeployment();

  const Adapter = await ethers.getContractFactory("Groth16EnergyInputVerifierAdapter", signer);
  const adapter = await Adapter.deploy(await mockVerifier.getAddress(), txOverrides);
  await adapter.waitForDeployment();
  return { mode: "mock", verifierAddress: await adapter.getAddress(), adapter, mockVerifier };
}

async function makeProofBackedAdd(
  context: OperationProofContext,
  notary: any,
  owner: string,
  serverKey: string,
  lastEntry: PreparedInput,
  encryptedTotalHex: string,
  encryptedTotalPath: string,
  outputPath: string,
  nonceSeed: string
) {
  dispatchAddU32(serverKey, encryptedTotalPath, lastEntry.ciphertextPath, outputPath);
  const output = readCiphertextHex(outputPath);
  const proof = await makeOperationProof(
    context,
    notary,
    owner,
    OperationKind.Add,
    binaryInputSetHash(lastEntry.ciphertextHex, encryptedTotalHex),
    output,
    nonceSeed
  );
  return { output, proof };
}

async function makeProofBackedMulScalar(
  context: OperationProofContext,
  notary: any,
  owner: string,
  serverKey: string,
  input: PreparedInput,
  scalar: bigint,
  outputPath: string,
  nonceSeed: string
) {
  dispatchMulScalarU32(serverKey, input.ciphertextPath, scalar, outputPath);
  const output = readCiphertextHex(outputPath);
  const proof = await makeOperationProof(
    context,
    notary,
    owner,
    OperationKind.MulScalar,
    scalarInputSetHash(input.ciphertextHex, input.metadataHash, scalar),
    output,
    nonceSeed
  );
  return { output, proof };
}

async function setupOperationProofContext(notary: any, txOverrides: TxOverrides, signer: TxSigner): Promise<OperationProofContext> {
  const requestedMode = (process.env.FHEBC_BENCHMARK_OPERATION_PROOF_MODE ?? "mock").toLowerCase();
  const mode = requestedMode === "real" ? "groth16" : requestedMode;
  if (mode === "groth16") {
    process.env.FHEBC_OPERATION_PROOF_BACKEND = "groth16";
    return { mode: "groth16", verifierAddress: await ensureOperationProofVerifier(notary, txOverrides, signer) };
  }
  if (mode !== "mock") {
    throw new Error(`Invalid FHEBC_BENCHMARK_OPERATION_PROOF_MODE: ${mode}`);
  }

  const MockVerifier = await ethers.getContractFactory("MockGroth16OperationVerifier", signer);
  const mockVerifier = await MockVerifier.deploy(true, txOverrides);
  await mockVerifier.waitForDeployment();

  const authorityCommitment = process.env.FHEBC_OPERATION_ZK_AUTHORITY_COMMITMENT ?? fieldSafeBytes32("benchmark-operation-authority");
  const OperationAdapter = await ethers.getContractFactory("Groth16OperationProofVerifierAdapter", signer);
  const adapter = await OperationAdapter.deploy(await mockVerifier.getAddress(), authorityCommitment, txOverrides);
  await adapter.waitForDeployment();
  await (await notary.setOperationProofVerifier(await adapter.getAddress(), txOverrides)).wait();

  return { mode: "mock", verifierAddress: await adapter.getAddress(), adapter, mockVerifier };
}

async function makeOperationProof(
  context: OperationProofContext,
  notary: any,
  owner: string,
  kind: number,
  inputSetHash: string,
  outputCiphertextHex: string,
  nonceSeed: string
) {
  if (context.mode === "groth16") {
    return proveOperationProof(notary, owner, kind, inputSetHash, outputCiphertextHex, nonceSeed);
  }

  const nonce = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address", "uint8", "bytes32", "bytes32", "uint256"],
      [nonceSeed, owner, kind, inputSetHash, ethers.keccak256(outputCiphertextHex), Date.now()]
    )
  );
  const digest = await notary.operationProofDigest(
    owner,
    kind,
    inputSetHash,
    ethers.keccak256(outputCiphertextHex),
    ethers.ZeroHash,
    nonce
  );
  const authorityCommitment = await context.adapter.authorizedAuthorityCommitment();
  const attestationHash = fieldSafeBytes32(`${nonceSeed}:${digest}:operation-attestation`);
  const rawPublicInputs = await context.adapter.publicSignals(digest, authorityCommitment, attestationHash);
  const publicInputs = Array.from(rawPublicInputs);
  await (await context.mockVerifier.setExpectedPublicSignals(publicInputs, {
    gasLimit: 2_000_000n,
    gasPrice: BigInt(process.env.FHEBC_BESU_GAS_PRICE_WEI ?? "1000")
  })).wait();
  const proof = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "uint256[2]", "uint256[2][2]", "uint256[2]", "uint256[4]"],
    [
      authorityCommitment,
      attestationHash,
      [0, 0],
      [
        [0, 0],
        [0, 0]
      ],
      [0, 0],
      publicInputs
    ]
  );
  return { nonce, digest, proof, authorityCommitment, attestationHash };
}

async function main() {
  const [baseOwner] = await ethers.getSigners();
  // The benchmark is strictly sequential. Using NonceManager around long native
  // TFHE transactions can turn a provider retry into a Besu "Known transaction"
  // error even when the transaction is later mined correctly.
  const owner = baseOwner;
  const ownerAddress = await owner.getAddress();
  const network = await ethers.provider.getNetwork();
  const runs = Number(process.env.FHEBC_BENCHMARK_RUNS ?? "10");
  const gasPrice = BigInt(process.env.FHEBC_BESU_GAS_PRICE_WEI ?? "1000");
  const consensusSafeOnly = process.env.FHEBC_BENCHMARK_CONSENSUS_SAFE_ONLY === "1";
  const allProofBacked = process.env.FHEBC_BENCHMARK_ALL_PROOF_BACKED !== "0";
  const selectedOperations = parseBenchmarkOperations();
  const shouldMeasure = (operation: string) => selectedOperations === null || selectedOperations.has(operation);
  const selectedOperationLabel = selectedOperations === null ? "all" : Array.from(selectedOperations).join(",");
  const txOverrides = {
    gasLimit: BigInt(process.env.FHEBC_TX_GAS_LIMIT ?? "100000000"),
    gasPrice
  };
  const scalar = BigInt(process.env.FHEBC_SCALAR ?? "3");
  const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const outDir = path.resolve(process.env.FHEBC_BENCHMARK_OUT_DIR ?? path.join("runtime", "benchmarks", `besufhe-${runId}`));
  const clientKey = path.resolve(process.env.FHEBC_TFHE_CLIENT_KEY_PATH ?? projectPath("runtime", "keys", "client.key"));
  const serverKey = path.resolve(process.env.FHEBC_TFHE_SERVER_KEY_PATH ?? projectPath("runtime", "keys", "server.key"));
  const samples: Sample[] = [];

  fs.mkdirSync(outDir, { recursive: true });
  ensureKeys(clientKey, serverKey);

  const smoke = await ethers.provider.call({ to: FHE_PRECOMPILE_ADDRESS, data: "0x" });
  if (smoke !== "0x0100000000000000") {
    throw new Error(`FHE precompile not available at ${FHE_PRECOMPILE_ADDRESS}; got ${smoke}`);
  }

  const Notary = await ethers.getContractFactory("EnergyDataNotaryOnChain", owner);
  const notary = await Notary.deploy(txOverrides);
  await notary.waitForDeployment();
  const inputProofContext = await setupInputProofContext(txOverrides, owner);
  await (await notary.setInputProofVerifier(inputProofContext.verifierAddress, txOverrides)).wait();
  const operationProofContext = await setupOperationProofContext(notary, txOverrides, owner);

  console.log("=".repeat(90));
  console.log("BesuFHE EnergyDataNotary 10x benchmark");
  console.log("=".repeat(90));
  console.log(`Network       : ${network.name} (chainId ${network.chainId})`);
  console.log(`Owner         : ${ownerAddress}`);
  console.log(`Notary        : ${await notary.getAddress()}`);
  console.log(`Input proof   : ${inputProofContext.verifierAddress} (${inputProofContext.mode})`);
  console.log(`Operation proof: ${operationProofContext.verifierAddress} (${operationProofContext.mode})`);
  console.log(
    `Benchmark mode: ${
      allProofBacked
        ? "proof-backed tx operations + native views (QBFT-safe default)"
        : consensusSafeOnly
          ? "experimental native linear subset"
          : "experimental native linear + proof-backed aggregates"
    }`
  );
  console.log(`Runs          : ${runs}`);
  console.log(`Operations    : ${selectedOperationLabel}`);
  console.log(`Gas price     : ${gasPrice.toString()} wei`);
  console.log(`Output dir    : ${outDir}`);
  console.log("=".repeat(90));

  console.log("\nWarmup...");
  const warmTotal = await prepareInput(
    notary,
    inputProofContext,
    ownerAddress,
    outDir,
    "warm-total",
    10,
    10,
    10,
    clientKey,
    txOverrides
  );
  await initializeTotal(notary, warmTotal, txOverrides);
  const warmEntry = await prepareInput(
    notary,
    inputProofContext,
    ownerAddress,
    outDir,
    "warm-entry",
    42,
    0,
    1_000_000,
    clientKey,
    txOverrides
  );
  await addInput(notary, warmEntry, txOverrides, false, samples);
  let warmAddOutput: string;
  const warmAddPath = path.join(outDir, "warm-add.ct");
  if (allProofBacked) {
    const warmTotalHex = await notary.getEncryptedTotal();
    const warmTotalPath = path.join(outDir, "warm-total-current.ct");
    fs.writeFileSync(warmTotalPath, hexToBuffer(warmTotalHex));
    const warmAdd = await makeProofBackedAdd(
      operationProofContext,
      notary,
      ownerAddress,
      serverKey,
      warmEntry,
      warmTotalHex,
      warmTotalPath,
      warmAddPath,
      "warm-add"
    );
    await (await notary.addLastEntryToEncryptedTotalProof(warmAdd.output, warmAdd.proof.nonce, warmAdd.proof.proof, txOverrides)).wait();
    warmAddOutput = warmAdd.output;
  } else {
    await (await notary.addLastEntryToEncryptedTotal(txOverrides)).wait();
    warmAddOutput = await notary.getEncryptedTotal();
    fs.writeFileSync(warmAddPath, hexToBuffer(warmAddOutput));
  }
  if (shouldMeasure("mul_scalar")) {
    if (allProofBacked) {
      const warmMulPath = path.join(outDir, "warm-mul.ct");
      const warmMul = await makeProofBackedMulScalar(
        operationProofContext,
        notary,
        ownerAddress,
        serverKey,
        warmEntry,
        scalar,
        warmMulPath,
        "warm-mul"
      );
      await (
        await notary.multiplyLastEntryByConstantProof(scalar, warmMul.output, warmMul.proof.nonce, warmMul.proof.proof, txOverrides)
      ).wait();
    } else {
      await (await notary.multiplyLastEntryByConstant(scalar, txOverrides)).wait();
    }
  }
  const needsAggregateWarmup =
    !consensusSafeOnly &&
    (shouldMeasure("mean") || shouldMeasure("mean_view") || shouldMeasure("max") || shouldMeasure("max_view"));
  if (needsAggregateWarmup) {
    const warmAggregateHash = binaryInputSetHash(warmEntry.ciphertextHex, warmAddOutput);
    const warmMeanPath = path.join(outDir, "warm-mean.ct");
    dispatchMeanU32(serverKey, warmMeanPath, [warmEntry.ciphertextPath, warmAddPath]);
    const warmMeanOutput = readCiphertextHex(warmMeanPath);
    const warmMeanProof = await makeOperationProof(
      operationProofContext,
      notary,
      ownerAddress,
      OperationKind.Mean,
      warmAggregateHash,
      warmMeanOutput,
      "warm-mean"
    );
    await (await notary.meanLastEntryAndEncryptedTotalProof(warmMeanOutput, warmMeanProof.nonce, warmMeanProof.proof, txOverrides)).wait();
    const warmMaxPath = path.join(outDir, "warm-max.ct");
    dispatchMaxU32(serverKey, warmMaxPath, [warmEntry.ciphertextPath, warmAddPath]);
    const warmMaxOutput = readCiphertextHex(warmMaxPath);
    const warmMaxProof = await makeOperationProof(
      operationProofContext,
      notary,
      ownerAddress,
      OperationKind.Max,
      warmAggregateHash,
      warmMaxOutput,
      "warm-max"
    );
    await (await notary.maxLastEntryAndEncryptedTotalProof(warmMaxOutput, warmMaxProof.nonce, warmMaxProof.proof, txOverrides)).wait();
  }
  console.log("Warmup done.\n");

  for (let i = 0; i < runs; i++) {
    const value = 40 + i;
    console.log(`--- run ${i + 1}/${runs} value=${value} ---`);
    const prepared = await prepareInput(
      notary,
      inputProofContext,
      ownerAddress,
      outDir,
      `entry-${i + 1}`,
      value,
      0,
      1_000_000,
      clientKey,
      txOverrides
    );
    await addInput(notary, prepared, txOverrides, shouldMeasure("notarize"), samples);

    const totalBeforeAdd = await notary.getEncryptedTotal();
    const totalBeforeAddPath = path.join(outDir, `total-before-add-${i + 1}.ct`);
    fs.writeFileSync(totalBeforeAddPath, hexToBuffer(totalBeforeAdd));

    const addOutputPath = path.join(outDir, `add-${i + 1}.ct`);
    const addPreview = shouldMeasure("add_view")
      ? await measureView("add_view", samples, () => notary.previewAddLastEntryToEncryptedTotal())
      : null;
    let addOutput: string;
    if (allProofBacked) {
      const add = await makeProofBackedAdd(
        operationProofContext,
        notary,
        ownerAddress,
        serverKey,
        prepared,
        totalBeforeAdd,
        totalBeforeAddPath,
        addOutputPath,
        `add-${i + 1}`
      );
      addOutput = add.output;
      if (shouldMeasure("add")) {
        await measureTx("add", samples, () =>
          notary.addLastEntryToEncryptedTotalProof(add.output, add.proof.nonce, add.proof.proof, txOverrides)
        );
      } else {
        await (await notary.addLastEntryToEncryptedTotalProof(add.output, add.proof.nonce, add.proof.proof, txOverrides)).wait();
      }
    } else {
      if (shouldMeasure("add")) {
        await measureTx("add", samples, () => notary.addLastEntryToEncryptedTotal(txOverrides));
      } else {
        await (await notary.addLastEntryToEncryptedTotal(txOverrides)).wait();
      }
      addOutput = await notary.getEncryptedTotal();
      fs.writeFileSync(addOutputPath, hexToBuffer(addOutput));
    }

    if (shouldMeasure("mul_scalar") && allProofBacked) {
      const mulPath = path.join(outDir, `mul-scalar-${i + 1}.ct`);
      const mul = await makeProofBackedMulScalar(
        operationProofContext,
        notary,
        ownerAddress,
        serverKey,
        prepared,
        scalar,
        mulPath,
        `mul-scalar-${i + 1}`
      );
      await measureTx("mul_scalar", samples, () =>
        notary.multiplyLastEntryByConstantProof(scalar, mul.output, mul.proof.nonce, mul.proof.proof, txOverrides)
      );
    } else if (shouldMeasure("mul_scalar")) {
      await measureTx("mul_scalar", samples, () => notary.multiplyLastEntryByConstant(scalar, txOverrides));
    }

    const meanPreview =
      !consensusSafeOnly && shouldMeasure("mean_view")
        ? await measureView("mean_view", samples, () => notary.previewMeanLastEntryAndEncryptedTotal())
        : null;
    if (!consensusSafeOnly && shouldMeasure("mean")) {
      const meanOutputPath = path.join(outDir, `mean-${i + 1}.ct`);
      dispatchMeanU32(serverKey, meanOutputPath, [prepared.ciphertextPath, addOutputPath]);
      const meanOutput = readCiphertextHex(meanOutputPath);
      const meanProof = await makeOperationProof(
        operationProofContext,
        notary,
        ownerAddress,
        OperationKind.Mean,
        binaryInputSetHash(prepared.ciphertextHex, addOutput),
        meanOutput,
        `mean-${i + 1}`
      );
      await measureTx("mean", samples, () =>
        notary.meanLastEntryAndEncryptedTotalProof(meanOutput, meanProof.nonce, meanProof.proof, txOverrides)
      );
    }

    const maxPreview =
      !consensusSafeOnly && shouldMeasure("max_view")
        ? await measureView("max_view", samples, () => notary.previewMaxLastEntryAndEncryptedTotal())
        : null;
    if (!consensusSafeOnly && shouldMeasure("max")) {
      const maxOutputPath = path.join(outDir, `max-${i + 1}.ct`);
      dispatchMaxU32(serverKey, maxOutputPath, [prepared.ciphertextPath, addOutputPath]);
      const maxOutput = readCiphertextHex(maxOutputPath);
      const maxProof = await makeOperationProof(
        operationProofContext,
        notary,
        ownerAddress,
        OperationKind.Max,
        binaryInputSetHash(prepared.ciphertextHex, addOutput),
        maxOutput,
        `max-${i + 1}`
      );
      await measureTx("max", samples, () =>
        notary.maxLastEntryAndEncryptedTotalProof(maxOutput, maxProof.nonce, maxProof.proof, txOverrides)
      );
    }

    if (shouldMeasure("decrypt")) {
      const decryptTarget =
        consensusSafeOnly || process.env.FHEBC_BENCHMARK_DECRYPT_TARGET === "add"
          ? (addPreview ?? addOutput)
          : process.env.FHEBC_BENCHMARK_DECRYPT_TARGET === "mean"
            ? (meanPreview ?? addOutput)
            : (maxPreview ?? addOutput);
      measureDecrypt(
        "decrypt",
        samples,
        clientKey,
        serverKey,
        path.join(outDir, `decrypt-${i + 1}.ct`),
        decryptTarget
      );
    }
  }

  const summary = summarize(samples);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: allProofBacked
      ? `${inputProofContext.mode}-input-proof-proof-backed-${operationProofContext.mode}-zk-operation-proof-all-ops`
      : consensusSafeOnly
        ? `${inputProofContext.mode}-input-proof-native-linear-safe-subset-${operationProofContext.mode}-operation-proof`
        : `${inputProofContext.mode}-input-proof-native-linear-${operationProofContext.mode}-zk-operation-proof-aggregates`,
    network: { name: network.name, chainId: network.chainId.toString() },
      owner: ownerAddress,
    contracts: {
      notary: await notary.getAddress(),
      inputProofVerifier: inputProofContext.verifierAddress,
      inputProofMode: inputProofContext.mode,
      operationVerifier: operationProofContext.verifierAddress,
      operationProofMode: operationProofContext.mode
    },
    settings: {
      runs,
      scalar: scalar.toString(),
      gasPriceWei: gasPrice.toString(),
      txGasLimit: txOverrides.gasLimit.toString(),
      selectedOperations: selectedOperationLabel,
      decryptTarget: consensusSafeOnly ? "add_view" : (process.env.FHEBC_BENCHMARK_DECRYPT_TARGET ?? "max_view"),
      consensusSafeOnly,
      allProofBacked
    },
    samples,
    summary
  };

  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "summary.md"), markdownTable(summary, report.mode, gasPrice, allProofBacked));
  fs.writeFileSync(path.join(outDir, "table.tex"), latexTable(summary, report.mode, gasPrice, allProofBacked));

  console.log("\n" + markdownTable(summary, report.mode, gasPrice, allProofBacked));
  console.log(`JSON   : ${path.join(outDir, "report.json")}`);
  console.log(`Markdown: ${path.join(outDir, "summary.md")}`);
  console.log(`LaTeX  : ${path.join(outDir, "table.tex")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
