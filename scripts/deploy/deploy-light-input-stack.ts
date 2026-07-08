import fs from "node:fs";
import path from "node:path";
import { artifacts, ethers } from "hardhat";

type TxOverrides = {
  gasLimit: bigint;
  gasPrice: bigint;
};

async function deployGeneratedNoirVerifier(txOverrides: TxOverrides) {
  if (!(await artifacts.artifactExists("NoirEnergyInputGeneratedVerifier"))) {
    throw new Error(
      [
        "Input proof verifier missing.",
        "Set FHEBC_INPUT_PROOF_VERIFIER_ADDRESS to an existing IInputProofVerifier,",
        "or set FHEBC_NOIR_INPUT_VERIFIER_ADDRESS to a generated Noir verifier,",
        "or run `npm run proof:build:energy-input` followed by `npm run compile`."
      ].join(" ")
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

async function resolveInputProofVerifier(txOverrides: TxOverrides) {
  const configuredVerifier = process.env.FHEBC_INPUT_PROOF_VERIFIER_ADDRESS;
  if (configuredVerifier) {
    return { address: configuredVerifier, mode: "configured-input-proof-verifier" };
  }

  const generatedVerifier = process.env.FHEBC_NOIR_INPUT_VERIFIER_ADDRESS ?? await deployGeneratedNoirVerifier(txOverrides);
  const Adapter = await ethers.getContractFactory("NoirEnergyInputVerifierAdapter");
  const adapter = await Adapter.deploy(generatedVerifier, txOverrides);
  await adapter.waitForDeployment();
  if (process.env.FHEBC_FREEZE_INPUT_PROOF_ADAPTER !== "0") {
    await (await adapter.freezeConfiguration(txOverrides)).wait();
  }

  return { address: await adapter.getAddress(), mode: "noir-input-proof-adapter" };
}

async function resolveOperationProofVerifier(txOverrides: TxOverrides) {
  const configuredVerifier = process.env.FHEBC_OPERATION_PROOF_VERIFIER_ADDRESS;
  if (configuredVerifier) {
    return { address: configuredVerifier, mode: "configured-operation-proof-verifier" };
  }

  const commitment = process.env.FHEBC_OPERATION_ZK_AUTHORITY_COMMITMENT;
  if (!commitment || !ethers.isHexString(commitment, 32)) {
    throw new Error("Set FHEBC_OPERATION_ZK_AUTHORITY_COMMITMENT to deploy the Noir operation proof verifier.");
  }

  let generatedVerifier = process.env.FHEBC_NOIR_OPERATION_VERIFIER_ADDRESS;
  if (!generatedVerifier) {
    if (!(await artifacts.artifactExists("NoirOperationGeneratedVerifier"))) {
      throw new Error(
        "NoirOperationGeneratedVerifier missing. Run `npm run proof:build:operation-authority` and `npm run compile`, or set FHEBC_NOIR_OPERATION_VERIFIER_ADDRESS."
      );
    }
    const TranscriptLib = await ethers.getContractFactory("ZKTranscriptLib");
    const transcriptLib = await TranscriptLib.deploy(txOverrides);
    await transcriptLib.waitForDeployment();

    const Verifier = await ethers.getContractFactory("NoirOperationGeneratedVerifier", {
      libraries: { ZKTranscriptLib: await transcriptLib.getAddress() }
    });
    const verifier = await Verifier.deploy(txOverrides);
    await verifier.waitForDeployment();
    generatedVerifier = await verifier.getAddress();
  }

  const Adapter = await ethers.getContractFactory("NoirOperationProofVerifierAdapter");
  const adapter = await Adapter.deploy(generatedVerifier, commitment, txOverrides);
  await adapter.waitForDeployment();
  if (process.env.FHEBC_FREEZE_OPERATION_PROOF_ADAPTER !== "0") {
    await (await adapter.freezeConfiguration(txOverrides)).wait();
  }

  return { address: await adapter.getAddress(), mode: "noir-operation-proof-verifier" };
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
