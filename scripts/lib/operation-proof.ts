import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { artifacts, ethers } from "hardhat";
import { projectPath } from "./runtime";

export const OperationKind = {
  Add: 0,
  Sub: 1,
  MulScalar: 2,
  Eq: 3,
  Lt: 4,
  Select: 5,
  Mean: 6,
  Max: 7
} as const;

export type TxOverrides = {
  gasLimit: bigint;
  gasPrice: bigint;
};

export function binaryInputSetHash(leftCiphertextHex: string, rightCiphertextHex: string) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [ethers.keccak256(leftCiphertextHex), ethers.keccak256(rightCiphertextHex)]
    )
  );
}

export function scalarInputSetHash(ciphertextHex: string, metadataHash: string, scalar: bigint) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "uint64"],
      [ethers.keccak256(ciphertextHex), metadataHash, scalar]
    )
  );
}

export async function proveOperationProof(
  notary: any,
  owner: string,
  kind: number,
  inputSetHash: string,
  outputCiphertextHex: string,
  nonceSeed: string
) {
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

  const contextPath = projectPath(
    "runtime",
    "proof-contexts",
    `operation-${Date.now()}-${nonceSeed.replace(/[^a-zA-Z0-9_-]/g, "-")}.json`
  );
  fs.mkdirSync(path.dirname(contextPath), { recursive: true });
  fs.writeFileSync(path.resolve(contextPath), JSON.stringify({ label: nonceSeed, operationDigest: digest }, null, 2));

  const backend = (process.env.FHEBC_OPERATION_PROOF_BACKEND ?? "groth16").toLowerCase();
  if (backend !== "groth16") {
    throw new Error(`Unsupported operation proof backend: ${backend}. BesuFHE now uses Groth16.`);
  }
  const defaultCommand = "node scripts/proof/groth16/prove-operation-authority.js";
  const command = process.env.FHEBC_OPERATION_ZK_PROOF_COMMAND ?? defaultCommand;
  const output = execSync(`${command} ${JSON.stringify(contextPath)}`, {
    cwd: projectPath(),
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const line = output.split(/\r?\n/).filter((candidate) => candidate.trim().startsWith("{")).pop();
  if (!line) {
    throw new Error("Operation ZK proof command produced no output.");
  }
  const parsed = JSON.parse(line);
  if (!ethers.isHexString(parsed.proof)) {
    throw new Error("Operation ZK proof command JSON must contain a hex `proof` field.");
  }
  return {
    nonce,
    digest,
    proof: parsed.proof,
    authorityCommitment: parsed.authorityCommitment,
    attestationHash: parsed.attestationHash
  };
}

export async function ensureOperationProofVerifier(notary: any, txOverrides: TxOverrides, signer?: any) {
  const configured = process.env.FHEBC_OPERATION_PROOF_VERIFIER_ADDRESS;
  const current = await notary.operationProofVerifier();
  if (current !== ethers.ZeroAddress && !configured) {
    return current;
  }

  if (await notary.operationProofConfigurationFrozen()) {
    throw new Error("Notary operation proof configuration is frozen.");
  }

  const backend = (process.env.FHEBC_OPERATION_PROOF_BACKEND ?? "groth16").toLowerCase();
  if (backend !== "groth16") {
    throw new Error(`Unsupported operation proof backend: ${backend}. BesuFHE now uses Groth16.`);
  }
  const verifierAddress = configured ?? await deployGroth16OperationProofVerifier(txOverrides, signer);
  await (await notary.setOperationProofVerifier(verifierAddress, txOverrides)).wait();
  if (process.env.FHEBC_FREEZE_OPERATION_PROOF_CONFIG !== "0") {
    await (await notary.freezeOperationProofConfiguration(txOverrides)).wait();
  }
  return verifierAddress;
}

async function deployGroth16OperationProofVerifier(txOverrides: TxOverrides, signer?: any) {
  const commitment = process.env.FHEBC_OPERATION_ZK_AUTHORITY_COMMITMENT;
  if (!commitment || !ethers.isHexString(commitment, 32)) {
    throw new Error("Set FHEBC_OPERATION_ZK_AUTHORITY_COMMITMENT to deploy the Groth16 operation proof verifier.");
  }

  let generatedVerifier = process.env.FHEBC_GROTH16_OPERATION_VERIFIER_ADDRESS;
  if (!generatedVerifier) {
    if (!(await artifacts.artifactExists("Groth16OperationGeneratedVerifier"))) {
      throw new Error(
        "Groth16OperationGeneratedVerifier missing. Run `npm run proof:build:operation-authority:groth16` and `npm run compile`, or set FHEBC_GROTH16_OPERATION_VERIFIER_ADDRESS."
      );
    }
    const Verifier = await ethers.getContractFactory("Groth16OperationGeneratedVerifier", signer);
    const verifier = await Verifier.deploy(txOverrides);
    await verifier.waitForDeployment();
    generatedVerifier = await verifier.getAddress();
  }

  const Adapter = await ethers.getContractFactory("Groth16OperationProofVerifierAdapter", signer);
  const adapter = await Adapter.deploy(generatedVerifier, commitment, txOverrides);
  await adapter.waitForDeployment();
  if (process.env.FHEBC_FREEZE_OPERATION_PROOF_ADAPTER !== "0") {
    await (await adapter.freezeConfiguration(txOverrides)).wait();
  }
  return adapter.getAddress();
}
