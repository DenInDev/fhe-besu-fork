import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
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
  | { mode: "real"; verifierAddress: string; adapter?: never; mockVerifier?: never }
  | { mode: "mock"; verifierAddress: string; adapter: any; mockVerifier: any };

function hexToBuffer(hex: string) {
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

function bufferToHex(buffer: Buffer) {
  return ethers.hexlify(buffer);
}

function fieldSafeBytes32(seed: string) {
  return ethers.toBeHex(BigInt(ethers.keccak256(ethers.toUtf8Bytes(seed))) % BN254_SCALAR_FIELD, 32);
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
      ? "Nota: il benchmark usa `MockNoirProofVerifier` come input-proof verifier. Le tx `add`, `mul_scalar`, `mean` e `max` usano il flusso proof-backed ZK/Noir per evitare output FHE non deterministici tra validator. Le view restano chiamate native alla precompile su un singolo nodo."
      : "Nota: il benchmark usa `MockNoirProofVerifier` come input-proof verifier. `add` e `mul_scalar` restano native; `mean` e `max` usano il flusso proof-backed ZK/Noir. In modalita' `mock-operation-proof`, l'adapter Noir e' reale ma il verifier Noir e' mocked per rendere il benchmark comparabile e ripetibile."
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
      ? "% Nota: input proof verifier mocked. Operazioni tx proof-backed per evitare output FHE non deterministici tra validator; view native su singolo nodo."
      : "% Nota: input proof verifier mocked. In mock-operation-proof il verifier Noir operation e' mocked; adapter, digest, replay resistance e storage restano misurati."
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
  const rawPublicInputs = await adapter.publicInputs(owner, ciphertextHash, metadataHash, minValue, maxValue);
  await (await mockVerifier.setExpectedPublicInputs(Array.from(rawPublicInputs), txOverrides)).wait();
}

async function prepareInput(
  notary: any,
  adapter: any,
  mockVerifier: any,
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
  const metadataHash = fieldSafeBytes32(`metadata:${label}:${value}`);
  const nonce = ethers.keccak256(ethers.toUtf8Bytes(`${Date.now()}:${label}:${owner}:${ciphertextHash}`));

  await setMockPublicInputs(adapter, mockVerifier, owner, ciphertextHash, metadataHash, minValue, maxValue, txOverrides);

  const proof = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes32", "bytes32", "uint256", "uint256", "bytes32", "bytes", "bytes32[]"],
    [
      owner,
      ciphertextHash,
      metadataHash,
      minValue,
      maxValue,
      nonce,
      "0x1234",
      await adapter.publicInputs(owner, ciphertextHash, metadataHash, minValue, maxValue)
    ]
  );

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

async function setupOperationProofContext(notary: any, txOverrides: TxOverrides): Promise<OperationProofContext> {
  const mode = (process.env.FHEBC_BENCHMARK_OPERATION_PROOF_MODE ?? "mock").toLowerCase();
  if (mode === "real") {
    return { mode: "real", verifierAddress: await ensureOperationProofVerifier(notary, txOverrides) };
  }
  if (mode !== "mock") {
    throw new Error(`Invalid FHEBC_BENCHMARK_OPERATION_PROOF_MODE: ${mode}`);
  }

  const MockVerifier = await ethers.getContractFactory("MockNoirProofVerifier");
  const mockVerifier = await MockVerifier.deploy(true, txOverrides);
  await mockVerifier.waitForDeployment();

  const authorityCommitment = process.env.FHEBC_OPERATION_ZK_AUTHORITY_COMMITMENT ?? fieldSafeBytes32("benchmark-operation-authority");
  const OperationAdapter = await ethers.getContractFactory("NoirOperationProofVerifierAdapter");
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
  if (context.mode === "real") {
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
  const rawPublicInputs = await context.adapter.publicInputs(digest, authorityCommitment, attestationHash);
  const publicInputs = Array.from(rawPublicInputs);
  await (await context.mockVerifier.setExpectedPublicInputs(publicInputs, {
    gasLimit: 2_000_000n,
    gasPrice: BigInt(process.env.FHEBC_BESU_GAS_PRICE_WEI ?? "1000")
  })).wait();
  const proof = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "bytes", "bytes32[]"],
    [authorityCommitment, attestationHash, "0x1234", publicInputs]
  );
  return { nonce, digest, proof, authorityCommitment, attestationHash };
}

async function main() {
  const [owner] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const runs = Number(process.env.FHEBC_BENCHMARK_RUNS ?? "10");
  const gasPrice = BigInt(process.env.FHEBC_BESU_GAS_PRICE_WEI ?? "1000");
  const consensusSafeOnly = process.env.FHEBC_BENCHMARK_CONSENSUS_SAFE_ONLY === "1";
  const allProofBacked = process.env.FHEBC_BENCHMARK_ALL_PROOF_BACKED !== "0";
  const txOverrides = {
    gasLimit: BigInt(process.env.FHEBC_TX_GAS_LIMIT ?? "30000000"),
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

  const MockVerifier = await ethers.getContractFactory("MockNoirProofVerifier");
  const mockVerifier = await MockVerifier.deploy(true, txOverrides);
  await mockVerifier.waitForDeployment();

  const Adapter = await ethers.getContractFactory("NoirEnergyInputVerifierAdapter");
  const adapter = await Adapter.deploy(await mockVerifier.getAddress(), txOverrides);
  await adapter.waitForDeployment();

  const Notary = await ethers.getContractFactory("EnergyDataNotaryOnChain");
  const notary = await Notary.deploy(txOverrides);
  await notary.waitForDeployment();
  await (await notary.setInputProofVerifier(await adapter.getAddress(), txOverrides)).wait();
  const operationProofContext = await setupOperationProofContext(notary, txOverrides);

  console.log("=".repeat(90));
  console.log("BesuFHE EnergyDataNotary 10x benchmark");
  console.log("=".repeat(90));
  console.log(`Network       : ${network.name} (chainId ${network.chainId})`);
  console.log(`Owner         : ${owner.address}`);
  console.log(`Notary        : ${await notary.getAddress()}`);
  console.log(`Input proof   : mock-input-proof`);
  console.log(`Operation proof: ${operationProofContext.verifierAddress} (${operationProofContext.mode})`);
  console.log(
    `Benchmark mode: ${
      allProofBacked
        ? "proof-backed tx operations + native views"
        : consensusSafeOnly
          ? "native linear safe subset"
          : "native linear + proof-backed aggregates"
    }`
  );
  console.log(`Runs          : ${runs}`);
  console.log(`Gas price     : ${gasPrice.toString()} wei`);
  console.log(`Output dir    : ${outDir}`);
  console.log("=".repeat(90));

  console.log("\nWarmup...");
  const warmTotal = await prepareInput(
    notary,
    adapter,
    mockVerifier,
    owner.address,
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
    adapter,
    mockVerifier,
    owner.address,
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
      owner.address,
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
  if (allProofBacked) {
    const warmMulPath = path.join(outDir, "warm-mul.ct");
    const warmMul = await makeProofBackedMulScalar(
      operationProofContext,
      notary,
      owner.address,
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
  if (!consensusSafeOnly) {
    const warmAggregateHash = binaryInputSetHash(warmEntry.ciphertextHex, warmAddOutput);
    const warmMeanPath = path.join(outDir, "warm-mean.ct");
    dispatchMeanU32(serverKey, warmMeanPath, [warmEntry.ciphertextPath, warmAddPath]);
    const warmMeanOutput = readCiphertextHex(warmMeanPath);
    const warmMeanProof = await makeOperationProof(
      operationProofContext,
      notary,
      owner.address,
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
      owner.address,
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
      adapter,
      mockVerifier,
      owner.address,
      outDir,
      `entry-${i + 1}`,
      value,
      0,
      1_000_000,
      clientKey,
      txOverrides
    );
    await addInput(notary, prepared, txOverrides, true, samples);

    const totalBeforeAdd = await notary.getEncryptedTotal();
    const totalBeforeAddPath = path.join(outDir, `total-before-add-${i + 1}.ct`);
    fs.writeFileSync(totalBeforeAddPath, hexToBuffer(totalBeforeAdd));

    const addOutputPath = path.join(outDir, `add-${i + 1}.ct`);
    const addPreview = await measureView("add_view", samples, () => notary.previewAddLastEntryToEncryptedTotal());
    let addOutput: string;
    if (allProofBacked) {
      const add = await makeProofBackedAdd(
        operationProofContext,
        notary,
        owner.address,
        serverKey,
        prepared,
        totalBeforeAdd,
        totalBeforeAddPath,
        addOutputPath,
        `add-${i + 1}`
      );
      addOutput = add.output;
      await measureTx("add", samples, () =>
        notary.addLastEntryToEncryptedTotalProof(add.output, add.proof.nonce, add.proof.proof, txOverrides)
      );
    } else {
      await measureTx("add", samples, () => notary.addLastEntryToEncryptedTotal(txOverrides));
      addOutput = await notary.getEncryptedTotal();
      fs.writeFileSync(addOutputPath, hexToBuffer(addOutput));
    }

    if (allProofBacked) {
      const mulPath = path.join(outDir, `mul-scalar-${i + 1}.ct`);
      const mul = await makeProofBackedMulScalar(
        operationProofContext,
        notary,
        owner.address,
        serverKey,
        prepared,
        scalar,
        mulPath,
        `mul-scalar-${i + 1}`
      );
      await measureTx("mul_scalar", samples, () =>
        notary.multiplyLastEntryByConstantProof(scalar, mul.output, mul.proof.nonce, mul.proof.proof, txOverrides)
      );
    } else {
      await measureTx("mul_scalar", samples, () => notary.multiplyLastEntryByConstant(scalar, txOverrides));
    }

    const meanPreview = consensusSafeOnly
      ? null
      : await measureView("mean_view", samples, () => notary.previewMeanLastEntryAndEncryptedTotal());
    if (!consensusSafeOnly) {
      const meanOutputPath = path.join(outDir, `mean-${i + 1}.ct`);
      dispatchMeanU32(serverKey, meanOutputPath, [prepared.ciphertextPath, addOutputPath]);
      const meanOutput = readCiphertextHex(meanOutputPath);
      const meanProof = await makeOperationProof(
        operationProofContext,
        notary,
        owner.address,
        OperationKind.Mean,
        binaryInputSetHash(prepared.ciphertextHex, addOutput),
        meanOutput,
        `mean-${i + 1}`
      );
      await measureTx("mean", samples, () =>
        notary.meanLastEntryAndEncryptedTotalProof(meanOutput, meanProof.nonce, meanProof.proof, txOverrides)
      );
    }

    const maxPreview = consensusSafeOnly
      ? null
      : await measureView("max_view", samples, () => notary.previewMaxLastEntryAndEncryptedTotal());
    if (!consensusSafeOnly) {
      const maxOutputPath = path.join(outDir, `max-${i + 1}.ct`);
      dispatchMaxU32(serverKey, maxOutputPath, [prepared.ciphertextPath, addOutputPath]);
      const maxOutput = readCiphertextHex(maxOutputPath);
      const maxProof = await makeOperationProof(
        operationProofContext,
        notary,
        owner.address,
        OperationKind.Max,
        binaryInputSetHash(prepared.ciphertextHex, addOutput),
        maxOutput,
        `max-${i + 1}`
      );
      await measureTx("max", samples, () =>
        notary.maxLastEntryAndEncryptedTotalProof(maxOutput, maxProof.nonce, maxProof.proof, txOverrides)
      );
    }

    const decryptTarget =
      consensusSafeOnly || process.env.FHEBC_BENCHMARK_DECRYPT_TARGET === "add"
        ? addPreview
        : process.env.FHEBC_BENCHMARK_DECRYPT_TARGET === "mean"
          ? meanPreview
          : maxPreview;
    measureDecrypt(
      "decrypt",
      samples,
      clientKey,
      serverKey,
      path.join(outDir, `decrypt-${i + 1}.ct`),
      decryptTarget
    );
  }

  const summary = summarize(samples);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: allProofBacked
      ? `mock-input-proof-proof-backed-${operationProofContext.mode}-zk-operation-proof-all-ops`
      : consensusSafeOnly
        ? `mock-input-proof-native-linear-safe-subset-${operationProofContext.mode}-operation-proof`
        : `mock-input-proof-native-linear-${operationProofContext.mode}-zk-operation-proof-aggregates`,
    network: { name: network.name, chainId: network.chainId.toString() },
    owner: owner.address,
    contracts: {
      notary: await notary.getAddress(),
      adapter: await adapter.getAddress(),
      mockVerifier: await mockVerifier.getAddress(),
      operationVerifier: operationProofContext.verifierAddress,
      operationProofMode: operationProofContext.mode
    },
    settings: {
      runs,
      scalar: scalar.toString(),
      gasPriceWei: gasPrice.toString(),
      txGasLimit: txOverrides.gasLimit.toString(),
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
