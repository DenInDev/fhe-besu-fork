import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { artifacts, ethers, network } from "hardhat";
import { encryptU32, ensureKeys, ensureParent, projectPath } from "../lib/runtime";

const BN254_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

type TxResult = {
  index: number;
  owner: string;
  scheduledAtMs: number;
  sendStartedAtMs?: number;
  submittedAtMs?: number;
  confirmedAtMs?: number;
  txHash?: string;
  blockNumber?: number;
  gasUsed?: number;
  effectiveGasPrice?: string;
  error?: string;
};

type Stat = {
  min: number | null;
  mean: number | null;
  median: number | null;
  max: number | null;
  std: number | null;
};

type InputProofTemplate = {
  metadataHash: string;
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
  publicSignals: string[];
};

function numberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
}

function ratesEnv() {
  return (process.env.FHEBC_LOAD_RATES ?? "1,5,10,20")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function createSemaphore(limit: number) {
  let active = 0;
  const waiters: Array<() => void> = [];

  async function acquire() {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      const next = waiters.shift();
      if (next) next();
    };
  }

  return { acquire };
}

function avg(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStd(values: number[]) {
  if (values.length < 2) return 0;
  const mean = avg(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function stat(values: number[]): Stat {
  if (values.length === 0) return { min: null, mean: null, median: null, max: null, std: null };
  return {
    min: Math.min(...values),
    mean: avg(values),
    median: median(values),
    max: Math.max(...values),
    std: sampleStd(values)
  };
}

function emptyStat(): Stat {
  return { min: null, mean: null, median: null, max: null, std: null };
}

function fmt(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(digits);
}

function fieldSafeBytes32(seed: string) {
  return ethers.toBeHex(BigInt(ethers.keccak256(ethers.toUtf8Bytes(seed))) % BN254_SCALAR_FIELD, 32);
}

function fieldSalt(seed: string) {
  return (BigInt(ethers.keccak256(ethers.toUtf8Bytes(seed))) % BN254_SCALAR_FIELD).toString();
}

function parseLastJsonLine(output: string) {
  const line = output.split(/\r?\n/).filter(Boolean).pop();
  if (!line) throw new Error("Proof command produced no output.");
  return JSON.parse(line);
}

function runInputProofCommand(contextPath: string) {
  const command = process.env.FHEBC_ZK_PROOF_COMMAND ?? "node scripts/proof/groth16/prove-energy-input.js";
  const output = execSync(`${command} ${JSON.stringify(contextPath)}`, {
    cwd: projectPath(),
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const parsed = parseLastJsonLine(output);
  if (!ethers.isHexString(parsed.proof) || !ethers.isHexString(parsed.metadataHash, 32)) {
    throw new Error("Invalid input proof command output.");
  }
  return parsed as { metadataHash: string; proof: string };
}

function bufferToHex(buffer: Buffer) {
  return ethers.hexlify(buffer);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function deployGeneratedGroth16InputVerifier(txOverrides: { gasLimit: bigint; gasPrice: bigint }) {
  if (!(await artifacts.artifactExists("Groth16EnergyInputGeneratedVerifier"))) {
    throw new Error("No Groth16 input verifier artifact found. Run `npm run proof:build:energy-input` and `npm run compile`.");
  }

  const Verifier = await ethers.getContractFactory("Groth16EnergyInputGeneratedVerifier");
  const verifier = await Verifier.deploy(txOverrides);
  await verifier.waitForDeployment();
  return verifier.getAddress();
}

async function deployNotary(gasLimit: bigint, gasPrice: bigint) {
  const txOverrides = { gasLimit, gasPrice };
  const inputProofMode = (process.env.FHEBC_LOAD_INPUT_PROOF_MODE ?? "mock").toLowerCase();
  let verifierAddress: string;

  if (inputProofMode === "real" || inputProofMode === "groth16") {
    verifierAddress =
      process.env.FHEBC_GROTH16_INPUT_VERIFIER_ADDRESS ?? (await deployGeneratedGroth16InputVerifier(txOverrides));
  } else if (inputProofMode === "mock") {
    const Verifier = await ethers.getContractFactory("AcceptingGroth16EnergyInputVerifier");
    const verifier = await Verifier.deploy(txOverrides);
    await verifier.waitForDeployment();
    verifierAddress = await verifier.getAddress();
  } else {
    throw new Error(`Invalid FHEBC_LOAD_INPUT_PROOF_MODE: ${inputProofMode}`);
  }

  const Adapter = await ethers.getContractFactory("Groth16EnergyInputVerifierAdapter");
  const adapter = await Adapter.deploy(verifierAddress, txOverrides);
  await adapter.waitForDeployment();

  const Notary = await ethers.getContractFactory("EnergyDataNotaryOnChain");
  const notary = await Notary.deploy(txOverrides);
  await notary.waitForDeployment();
  await (await notary.setInputProofVerifier(await adapter.getAddress(), txOverrides)).wait();

  return { inputProofMode, verifierAddress, adapter, notary };
}

async function fundUsers(signers: any[], gasPrice: bigint) {
  const deployer = signers[0];
  const minBalance = ethers.parseEther("0.05");
  const topUp = ethers.parseEther("0.2");
  for (const signer of signers.slice(1)) {
    const balance = await ethers.provider.getBalance(signer.address);
    if (balance < minBalance) {
      await (await deployer.sendTransaction({ to: signer.address, value: topUp, gasPrice })).wait();
    }
  }
}

function publicInputs(owner: string, ciphertextHash: string, metadataHash: string, minValue: number, maxValue: number) {
  const ciphertextHashValue = BigInt(ciphertextHash);
  const low128Mask = (1n << 128n) - 1n;
  return [
    ethers.toBeHex(ciphertextHashValue >> 128n, 32),
    ethers.toBeHex(ciphertextHashValue & low128Mask, 32),
    ethers.toBeHex(BigInt(owner), 32),
    ethers.toBeHex(minValue, 32),
    ethers.toBeHex(maxValue, 32),
    metadataHash
  ];
}

async function preparePayload(
  owner: string,
  ciphertextHex: string,
  defaultMetadataHash: string,
  minValue: number,
  maxValue: number,
  nonce: string,
  template?: InputProofTemplate
) {
  const ciphertextHash = ethers.keccak256(ciphertextHex);
  const metadataHash = template?.metadataHash ?? defaultMetadataHash;
  const signals = template?.publicSignals ?? publicInputs(owner, ciphertextHash, metadataHash, minValue, maxValue);
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
      "uint256[6]"
    ],
    [
      owner,
      ciphertextHash,
      metadataHash,
      minValue,
      maxValue,
      nonce,
      template?.a ?? [0, 0],
      template?.b ?? [
        [0, 0],
        [0, 0]
      ],
      template?.c ?? [0, 0],
      signals
    ]
  );
  return { proof, ciphertextHash, metadataHash };
}

async function runProfile(params: {
  rate: number;
  durationSec: number;
  users: any[];
  notary: any;
  ciphertextHex: string;
  metadataHash: string;
  proofTemplates: Map<string, InputProofTemplate>;
  minValue: number;
  maxValue: number;
  gasLimit: bigint;
  gasPrice: bigint;
  outDir: string;
}) {
  const scheduledTx = Math.floor(params.rate * params.durationSec);
  const startBlock = await ethers.provider.getBlockNumber();
  const startedAtMs = Date.now() + 250;
  const baseNonces = new Map<string, number>();
  const localNonceOffsets = new Map<string, number>();
  const maxSubmitInflight = numberEnv(
    "FHEBC_LOAD_MAX_SUBMIT_INFLIGHT",
    Math.max(8, Math.min(64, Math.ceil(params.rate * 2)))
  );
  const submitSemaphore = createSemaphore(maxSubmitInflight);

  for (const signer of params.users) {
    baseNonces.set(signer.address, await ethers.provider.getTransactionCount(signer.address, "pending"));
    localNonceOffsets.set(signer.address, 0);
  }

  const results: TxResult[] = [];

  const tasks = Array.from({ length: scheduledTx }, async (_, index) => {
    const signer = params.users[index % params.users.length];
    const offset = localNonceOffsets.get(signer.address) ?? 0;
    localNonceOffsets.set(signer.address, offset + 1);
    const nonce = (baseNonces.get(signer.address) ?? 0) + offset;
    const scheduledAtMs = startedAtMs + Math.floor((index / params.rate) * 1000);
    const proofNonce = ethers.keccak256(ethers.toUtf8Bytes(`${params.rate}:${index}:${signer.address}:${scheduledAtMs}`));
    const result: TxResult = { index, owner: signer.address, scheduledAtMs };

    await sleep(scheduledAtMs - Date.now());
    const releaseSubmit = await submitSemaphore.acquire();
    result.sendStartedAtMs = Date.now();
    try {
      const payload = await preparePayload(
        signer.address,
        params.ciphertextHex,
        params.metadataHash,
        params.minValue,
        params.maxValue,
        proofNonce,
        params.proofTemplates.get(signer.address)
      );
      const tx = await params.notary
        .connect(signer)
        .addEnergyEntry(
          params.ciphertextHex,
          payload.metadataHash,
          params.minValue,
          params.maxValue,
          proofNonce,
          payload.proof,
          { gasLimit: params.gasLimit, gasPrice: params.gasPrice, nonce }
        );
      result.submittedAtMs = Date.now();
      result.txHash = tx.hash;
    } catch (error) {
      result.error = errorMessage(error).slice(0, 500);
    } finally {
      releaseSubmit();
    }
    results[index] = result;
  });

  await Promise.all(tasks);
  await pollReceipts(results, Math.max(120_000, params.durationSec * 5_000));

  const mined = results.filter((item) => item.blockNumber !== undefined && !item.error);
  const failed = results.filter((item) => item.error);
  const lastConfirmedAtMs = Math.max(...mined.map((item) => item.confirmedAtMs ?? startedAtMs), startedAtMs);
  const lastBlock = mined.length > 0 ? Math.max(...mined.map((item) => item.blockNumber ?? startBlock)) : startBlock;

  const blockMap = new Map<number, number>();
  for (const item of mined) {
    blockMap.set(item.blockNumber!, (blockMap.get(item.blockNumber!) ?? 0) + 1);
  }
  const blocks = [];
  for (const [number, benchmarkTxCount] of [...blockMap.entries()].sort((a, b) => a[0] - b[0])) {
    const block = await ethers.provider.getBlock(number);
    blocks.push({
      number,
      timestamp: Number(block?.timestamp ?? 0),
      txCount: Number(block?.transactions.length ?? 0),
      benchmarkTxCount
    });
  }

  const blockIntervals = [];
  for (let i = 1; i < blocks.length; i++) {
    blockIntervals.push(blocks[i].timestamp - blocks[i - 1].timestamp);
  }
  const endToEndLatencies = mined.map((item) => (item.confirmedAtMs ?? 0) - item.scheduledAtMs);
  const sendLatencies = mined.map((item) => (item.submittedAtMs ?? 0) - (item.sendStartedAtMs ?? 0));
  const scheduleDelays = results.map((item) => Math.max(0, (item.sendStartedAtMs ?? item.scheduledAtMs) - item.scheduledAtMs));
  const gasValues = mined.map((item) => item.gasUsed ?? 0);
  const txPerActiveBlock = blocks.map((block) => block.benchmarkTxCount);

  const report = {
    profile: {
      mode: "besufhe-notarize",
      inputProofMode: process.env.FHEBC_LOAD_INPUT_PROOF_MODE ?? "mock",
      rate: params.rate,
      durationSec: params.durationSec,
      scheduledTx,
      threads: params.users.length,
      users: params.users.length,
      network: network.name,
      chainId: network.config.chainId,
      gasPriceWei: params.gasPrice.toString(),
      maxSubmitInflight,
      startedAt: new Date(startedAtMs).toISOString()
    },
    summary: {
      acceptedTx: mined.length,
      minedTx: mined.length,
      failedTx: failed.length,
      startBlock,
      lastBlock,
      blocksRequiredToClose: lastBlock - startBlock + 1,
      activeBenchmarkBlocks: blocks.length,
      wallClockClosureMs: lastConfirmedAtMs - startedAtMs,
      drainMs: Math.max(0, lastConfirmedAtMs - (startedAtMs + params.durationSec * 1000)),
      closureThroughputTxPerSec: mined.length / Math.max(1, (lastConfirmedAtMs - startedAtMs) / 1000),
      maxScheduleDelayMs: Math.max(...scheduleDelays, 0)
    },
    stats: {
      gasUsed: stat(gasValues),
      sendLatencyMs: stat(sendLatencies),
      endToEndLatencyMs: stat(endToEndLatencies),
      scheduleDelayMs: stat(scheduleDelays),
      txPerActiveBlock: stat(txPerActiveBlock),
      activeBlockIntervalSec: stat(blockIntervals)
    },
    blocks,
    transactions: results
  };

  fs.writeFileSync(path.join(params.outDir, `${params.rate}tps.json`), JSON.stringify(report, null, 2));
  return report;
}

async function writeFailedProfile(params: {
  rate: number;
  durationSec: number;
  users: any[];
  gasPrice: bigint;
  outDir: string;
  error: unknown;
}) {
  let currentBlock = 0;
  try {
    currentBlock = await ethers.provider.getBlockNumber();
  } catch {
    currentBlock = 0;
  }

  const scheduledTx = Math.floor(params.rate * params.durationSec);
  const report = {
    profile: {
      mode: "besufhe-notarize",
      inputProofMode: process.env.FHEBC_LOAD_INPUT_PROOF_MODE ?? "mock",
      rate: params.rate,
      durationSec: params.durationSec,
      scheduledTx,
      threads: params.users.length,
      users: params.users.length,
      network: network.name,
      chainId: network.config.chainId,
      gasPriceWei: params.gasPrice.toString(),
      maxSubmitInflight: 0,
      startedAt: new Date().toISOString()
    },
    summary: {
      acceptedTx: 0,
      minedTx: 0,
      failedTx: scheduledTx,
      startBlock: currentBlock,
      lastBlock: currentBlock,
      blocksRequiredToClose: 0,
      activeBenchmarkBlocks: 0,
      wallClockClosureMs: 0,
      drainMs: 0,
      closureThroughputTxPerSec: 0,
      maxScheduleDelayMs: 0,
      error: errorMessage(params.error).slice(0, 1000)
    },
    stats: {
      gasUsed: emptyStat(),
      sendLatencyMs: emptyStat(),
      endToEndLatencyMs: emptyStat(),
      scheduleDelayMs: emptyStat(),
      txPerActiveBlock: emptyStat(),
      activeBlockIntervalSec: emptyStat()
    },
    blocks: [],
    transactions: []
  };

  fs.writeFileSync(path.join(params.outDir, `${params.rate}tps.json`), JSON.stringify(report, null, 2));
  return report;
}

async function pollReceipts(results: TxResult[], timeoutMs: number) {
  const pending = new Map<string, TxResult>();
  for (const result of results) {
    if (result.txHash && !result.error) pending.set(result.txHash, result);
  }

  const startedAt = Date.now();
  const batchSize = numberEnv("FHEBC_LOAD_RECEIPT_BATCH_SIZE", 8);
  while (pending.size > 0 && Date.now() - startedAt < timeoutMs) {
    const hashes = [...pending.keys()];
    for (let i = 0; i < hashes.length; i += batchSize) {
      const batch = hashes.slice(i, i + batchSize);
      const receipts = await Promise.all(
        batch.map(async (hash) => {
          try {
            return [hash, await ethers.provider.getTransactionReceipt(hash)] as const;
          } catch {
            return [hash, null] as const;
          }
        })
      );
      for (const [hash, receipt] of receipts) {
        if (!receipt) continue;
        const result = pending.get(hash);
        if (!result) continue;
        result.confirmedAtMs = Date.now();
        result.blockNumber = Number(receipt.blockNumber);
        result.gasUsed = Number(receipt.gasUsed);
        result.effectiveGasPrice = receipt.gasPrice?.toString?.() ?? "0";
        pending.delete(hash);
      }
    }
    if (pending.size > 0) await sleep(500);
  }

  for (const result of pending.values()) {
    result.error = `receipt timeout after ${timeoutMs} ms`;
  }
}

function writeSummary(outDir: string, reports: any[]) {
  const md = [];
  md.push("# BesuFHE notarize sustained load summary");
  md.push("");
  md.push(`Input proof mode: ${reports[0]?.profile?.inputProofMode ?? "unknown"}. Adapter digest/public-input binding enabled.`);
  md.push("");
  md.push("## Workload Closure");
  md.push("");
  md.push("| Rate (tx/s) | Threads | Scheduled tx | Mined tx | Failed tx | Closure (ms) | Throughput (tx/s) | Blocks to close | Active blocks | Active tx/block mean |");
  md.push("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const report of reports) {
    md.push(
      `| ${report.profile.rate} | ${report.profile.threads} | ${report.profile.scheduledTx} | ${report.summary.minedTx} | ${report.summary.failedTx} | ${report.summary.wallClockClosureMs} | ${fmt(report.summary.closureThroughputTxPerSec, 3)} | ${report.summary.blocksRequiredToClose} | ${report.summary.activeBenchmarkBlocks} | ${fmt(report.stats.txPerActiveBlock.mean, 1)} |`
    );
  }
  md.push("");
  md.push("## addEnergyEntry Statistics");
  md.push("");
  md.push("| Rate (tx/s) | Gas mean | Latency mean (ms) | Latency median (ms) | Latency max (ms) | Latency std.dev (ms) |");
  md.push("|---:|---:|---:|---:|---:|---:|");
  for (const report of reports) {
    md.push(
      `| ${report.profile.rate} | ${fmt(report.stats.gasUsed.mean, 1)} | ${fmt(report.stats.endToEndLatencyMs.mean, 1)} | ${fmt(report.stats.endToEndLatencyMs.median, 1)} | ${fmt(report.stats.endToEndLatencyMs.max, 1)} | ${fmt(report.stats.endToEndLatencyMs.std, 1)} |`
    );
  }
  md.push("");
  md.push("## Block Statistics");
  md.push("");
  md.push("| Rate (tx/s) | Block interval mean (s) | Block interval max (s) | Tx/active block mean | Tx/active block max |");
  md.push("|---:|---:|---:|---:|---:|");
  for (const report of reports) {
    md.push(
      `| ${report.profile.rate} | ${fmt(report.stats.activeBlockIntervalSec.mean, 2)} | ${fmt(report.stats.activeBlockIntervalSec.max, 1)} | ${fmt(report.stats.txPerActiveBlock.mean, 1)} | ${fmt(report.stats.txPerActiveBlock.max, 1)} |`
    );
  }

  const tex = [];
  tex.push("% BesuFHE sustained load table");
  tex.push("\\begin{table}[H]");
  tex.push("\\centering");
  tex.push("\\caption{BesuFHE notarize sostenuto}");
  tex.push("\\label{tab:besufhe-notarize-load}");
  tex.push("\\begin{tabular}{rrrrrrrr}");
  tex.push("\\hline");
  tex.push("\\textbf{Rate} & \\textbf{Tx sched.} & \\textbf{Tx minate} & \\textbf{Fail} & \\textbf{Throughput} & \\textbf{Blocchi} & \\textbf{Tx/blocco} & \\textbf{Latenza media} \\\\");
  tex.push("\\hline");
  for (const report of reports) {
    tex.push(
      `${report.profile.rate} & ${report.profile.scheduledTx} & ${report.summary.minedTx} & ${report.summary.failedTx} & ${fmt(report.summary.closureThroughputTxPerSec, 2)} & ${report.summary.blocksRequiredToClose} & ${fmt(report.stats.txPerActiveBlock.mean, 1)} & ${fmt(report.stats.endToEndLatencyMs.mean, 0)} \\\\`
    );
  }
  tex.push("\\hline");
  tex.push("\\end{tabular}");
  tex.push("\\end{table}");

  fs.writeFileSync(path.join(outDir, "summary-besufhe-load.md"), md.join("\n"));
  fs.writeFileSync(path.join(outDir, "summary-besufhe-load.tex"), tex.join("\n"));
  fs.writeFileSync(path.join(outDir, "summary-besufhe-load.json"), JSON.stringify(reports, null, 2));
}

function decodeInputProof(proof: string): InputProofTemplate {
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
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
    proof
  );
  return {
    metadataHash: decoded[2],
    a: Array.from(decoded[6]) as [string, string],
    b: decoded[7].map((row: bigint[]) => Array.from(row)) as [[string, string], [string, string]],
    c: Array.from(decoded[8]) as [string, string],
    publicSignals: Array.from(decoded[9])
  };
}

async function prepareProofTemplates(params: {
  inputProofMode: string;
  users: any[];
  outDir: string;
  ciphertextHex: string;
  minValue: number;
  maxValue: number;
  plaintext: number;
}) {
  const templates = new Map<string, InputProofTemplate>();
  if (params.inputProofMode !== "real" && params.inputProofMode !== "groth16") return templates;

  const ciphertextHash = ethers.keccak256(params.ciphertextHex);
  console.log(`Preparing real Groth16 input proof templates for ${params.users.length} users...`);
  for (const [index, user] of params.users.entries()) {
    const label = `load-user-${index}`;
    const nonce = ethers.keccak256(ethers.toUtf8Bytes(`template:${label}:${user.address}:${ciphertextHash}`));
    const contextPath = path.join(params.outDir, `${label}-input-proof-context.json`);
    fs.writeFileSync(
      contextPath,
      JSON.stringify(
        {
          label,
          owner: user.address,
          ciphertextHash,
          minValue: params.minValue.toString(),
          maxValue: params.maxValue.toString(),
          nonce,
          plaintext: params.plaintext.toString(),
          salt: fieldSalt(`${label}:${user.address}:${ciphertextHash}`)
        },
        null,
        2
      )
    );
    const proofResult = runInputProofCommand(contextPath);
    templates.set(user.address, decodeInputProof(proofResult.proof));
    console.log(`  input proof ${index + 1}/${params.users.length}`);
  }
  return templates;
}

async function main() {
  const outDir = path.resolve(process.env.FHEBC_LOAD_OUT_DIR ?? path.join(projectPath(), "runtime", `besufhe-load-${Date.now()}`));
  fs.mkdirSync(outDir, { recursive: true });

  const durationSec = numberEnv("FHEBC_LOAD_DURATION_SEC", 30);
  const maxUsers = numberEnv("FHEBC_LOAD_USERS", 20);
  const gasLimit = BigInt(process.env.FHEBC_LOAD_TX_GAS_LIMIT ?? "30000000");
  const gasPrice = BigInt(process.env.FHEBC_BESU_GAS_PRICE_WEI ?? "1000");
  const clientKey = process.env.FHEBC_CLIENT_KEY_PATH ?? path.join(projectPath(), "runtime", "keys", "client_key.bin");
  const serverKey = process.env.FHEBC_SERVER_KEY_PATH ?? path.join(projectPath(), "runtime", "keys", "server_key.bin");
  ensureKeys(clientKey, serverKey);

  const ciphertextPath = path.join(outDir, "load-entry.ct");
  ensureParent(ciphertextPath);
  const plaintext = numberEnv("FHEBC_LOAD_VALUE", 42);
  encryptU32(clientKey, plaintext, ciphertextPath);
  const ciphertextHex = bufferToHex(fs.readFileSync(ciphertextPath));
  const metadataHash = fieldSafeBytes32("besufhe-load-metadata");
  const minValue = numberEnv("FHEBC_LOAD_MIN", 0);
  const maxValue = numberEnv("FHEBC_LOAD_MAX", 1_000_000);

  const signers = await ethers.getSigners();
  const users = signers.slice(0, Math.min(maxUsers, signers.length));
  if (users.length === 0) throw new Error("No signers available");

  console.log("=".repeat(90));
  console.log("BesuFHE notarize sustained load benchmark");
  console.log("=".repeat(90));
  console.log(`Network : ${network.name} (${network.config.chainId})`);
  console.log(`Rates   : ${ratesEnv().join(", ")} tx/s`);
  console.log(`Duration: ${durationSec}s`);
  console.log(`Users   : ${users.length}`);
  console.log(`Out dir : ${outDir}`);
  console.log("=".repeat(90));

  await fundUsers(users, gasPrice);
  const { inputProofMode, notary } = await deployNotary(gasLimit, gasPrice);
  console.log(`Notary  : ${await notary.getAddress()}`);
  console.log(`Input proof mode: ${inputProofMode}`);

  const proofTemplates = await prepareProofTemplates({
    inputProofMode,
    users,
    outDir,
    ciphertextHex,
    minValue,
    maxValue,
    plaintext
  });

  const reports = [];
  for (const rate of ratesEnv()) {
    console.log(`\n>>> ${rate} tx/s`);
    const profileUsers = users;
    const report = await runProfile({
      rate,
      durationSec,
      users: profileUsers,
      notary,
      ciphertextHex,
      metadataHash,
      proofTemplates,
      minValue,
      maxValue,
      gasLimit,
      gasPrice,
      outDir
    }).catch((error) =>
      writeFailedProfile({
        rate,
        durationSec,
        users: profileUsers,
        gasPrice,
        outDir,
        error
      })
    );
    reports.push(report);
    console.log(
      `rate=${rate} mined=${report.summary.minedTx}/${report.profile.scheduledTx} failed=${report.summary.failedTx} throughput=${fmt(report.summary.closureThroughputTxPerSec, 3)} tx/s blocks=${report.summary.blocksRequiredToClose}`
    );
  }

  writeSummary(outDir, reports);
  console.log(`\nSummary: ${path.join(outDir, "summary-besufhe-load.md")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
