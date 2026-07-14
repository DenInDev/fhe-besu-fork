import fs from "node:fs";
import path from "node:path";
import { artifacts, ethers } from "hardhat";

type TxOverrides = {
  gasLimit: bigint;
  gasPrice: bigint;
};

async function deployGeneratedGroth16InputVerifier(txOverrides: TxOverrides) {
  if (!(await artifacts.artifactExists("Groth16EnergyInputGeneratedVerifier"))) {
    throw new Error(
      "Groth16EnergyInputGeneratedVerifier missing. Run `npm run proof:build:energy-input:groth16` and `npm run compile`, or set FHEBC_GROTH16_INPUT_VERIFIER_ADDRESS."
    );
  }

  const Verifier = await ethers.getContractFactory("Groth16EnergyInputGeneratedVerifier");
  const verifier = await Verifier.deploy(txOverrides);
  await verifier.waitForDeployment();
  return verifier.getAddress();
}

async function resolveInputProofVerifier(txOverrides: TxOverrides) {
  const configuredVerifier = process.env.FHEBC_INPUT_PROOF_VERIFIER_ADDRESS;
  if (configuredVerifier) {
    return { address: configuredVerifier, mode: "configured-input-proof-verifier" };
  }

  const backend = (process.env.FHEBC_INPUT_PROOF_BACKEND ?? "groth16").toLowerCase();
  if (backend !== "groth16") {
    throw new Error(`Unsupported input proof backend: ${backend}. BesuFHE now uses Groth16.`);
  }
  const generatedVerifier =
    process.env.FHEBC_GROTH16_INPUT_VERIFIER_ADDRESS ?? await deployGeneratedGroth16InputVerifier(txOverrides);
  const Adapter = await ethers.getContractFactory("Groth16EnergyInputVerifierAdapter");
  const adapter = await Adapter.deploy(generatedVerifier, txOverrides);
  await adapter.waitForDeployment();
  if (process.env.FHEBC_FREEZE_INPUT_PROOF_ADAPTER !== "0") {
    await (await adapter.freezeConfiguration(txOverrides)).wait();
  }

  return { address: await adapter.getAddress(), mode: `${backend}-input-proof-adapter` };
}

async function resolveOperationProofVerifier(txOverrides: TxOverrides) {
  const configuredVerifier = process.env.FHEBC_OPERATION_PROOF_VERIFIER_ADDRESS;
  if (configuredVerifier) {
    return { address: configuredVerifier, mode: "configured-operation-proof-verifier" };
  }

  const commitment = process.env.FHEBC_OPERATION_ZK_AUTHORITY_COMMITMENT;
  if (!commitment || !ethers.isHexString(commitment, 32)) {
    throw new Error("Set FHEBC_OPERATION_ZK_AUTHORITY_COMMITMENT to deploy the Groth16 operation proof verifier.");
  }

  const backend = (process.env.FHEBC_OPERATION_PROOF_BACKEND ?? "groth16").toLowerCase();
  if (backend !== "groth16") {
    throw new Error(`Unsupported operation proof backend: ${backend}. BesuFHE now uses Groth16.`);
  }
  let generatedVerifier = process.env.FHEBC_GROTH16_OPERATION_VERIFIER_ADDRESS;
  if (!generatedVerifier) {
    if (!(await artifacts.artifactExists("Groth16OperationGeneratedVerifier"))) {
      throw new Error(
        "Groth16OperationGeneratedVerifier missing. Run `npm run proof:build:operation-authority:groth16` and `npm run compile`, or set FHEBC_GROTH16_OPERATION_VERIFIER_ADDRESS."
      );
    }
    const Verifier = await ethers.getContractFactory("Groth16OperationGeneratedVerifier");
    const verifier = await Verifier.deploy(txOverrides);
    await verifier.waitForDeployment();
    generatedVerifier = await verifier.getAddress();
  }

  const Adapter = await ethers.getContractFactory("Groth16OperationProofVerifierAdapter");
  const adapter = await Adapter.deploy(generatedVerifier, commitment, txOverrides);
  await adapter.waitForDeployment();
  if (process.env.FHEBC_FREEZE_OPERATION_PROOF_ADAPTER !== "0") {
    await (await adapter.freezeConfiguration(txOverrides)).wait();
  }

  return { address: await adapter.getAddress(), mode: `${backend}-operation-proof-verifier` };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const gasPrice = BigInt(process.env.FHEBC_BESU_GAS_PRICE_WEI ?? "1000");
  const txOverrides = { gasLimit: 20_000_000n, gasPrice };
  const freezeConfig = process.env.FHEBC_FREEZE_INPUT_PROOF_CONFIG !== "0";
  const freezeOperationConfig = process.env.FHEBC_FREEZE_OPERATION_PROOF_CONFIG !== "0";

  console.log("=".repeat(78));
  console.log("BesuFHE EnergyDataNotary deployment");
  console.log("=".repeat(78));
  console.log(`Network      : ${network.name} (chainId ${network.chainId})`);
  console.log(`Deployer     : ${deployer.address}`);
  console.log("FHE precompile expected at: 0x0000000000000000000000000000000000000100");

  const verifier = await resolveInputProofVerifier(txOverrides);
  const operationVerifier = await resolveOperationProofVerifier(txOverrides);

  const Notary = await ethers.getContractFactory("EnergyDataNotaryOnChain");
  const notary = await Notary.deploy(txOverrides);
  await notary.waitForDeployment();
  await (await notary.setInputProofVerifier(verifier.address, txOverrides)).wait();
  await (await notary.setOperationProofVerifier(operationVerifier.address, txOverrides)).wait();
  if (freezeConfig) {
    await (await notary.freezeInputProofConfiguration(txOverrides)).wait();
  }
  if (freezeOperationConfig) {
    await (await notary.freezeOperationProofConfiguration(txOverrides)).wait();
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    mode: verifier.mode,
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    addresses: {
      inputProofVerifier: verifier.address,
      operationProofVerifier: operationVerifier.address,
      energyDataNotary: await notary.getAddress()
    },
    frozen: {
      notaryInputProof: await notary.inputProofConfigurationFrozen(),
      notaryOperationProof: await notary.operationProofConfigurationFrozen()
    }
  };

  const manifestPath = path.resolve(
    process.env.FHEBC_DEPLOYMENT_MANIFEST ?? "runtime/deployments/fhebc-besu.local.json"
  );
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`Input proof verifier: ${verifier.address} (${verifier.mode})`);
  console.log(`Operation verifier : ${operationVerifier.address} (${operationVerifier.mode})`);
  console.log(`EnergyDataNotary   : ${manifest.addresses.energyDataNotary}`);
  console.log(`Manifest           : ${manifestPath}`);
  console.log("=".repeat(78));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
