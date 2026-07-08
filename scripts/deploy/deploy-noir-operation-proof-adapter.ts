import fs from "node:fs";
import path from "node:path";
import { artifacts, ethers } from "hardhat";

type TxOverrides = {
  gasLimit: bigint;
  gasPrice: bigint;
};

async function deployGeneratedNoirOperationVerifier(txOverrides: TxOverrides) {
  if (!(await artifacts.artifactExists("NoirOperationGeneratedVerifier"))) {
    throw new Error(
      [
        "Operation proof verifier missing.",
        "Set FHEBC_NOIR_OPERATION_VERIFIER_ADDRESS to an existing generated Noir verifier,",
        "or run `npm run proof:build:operation-authority` followed by `npm run compile`."
      ].join(" ")
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
  return verifier.getAddress();
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const gasPrice = BigInt(process.env.FHEBC_BESU_GAS_PRICE_WEI ?? "1000");
  const txOverrides = { gasLimit: 20_000_000n, gasPrice };
  const commitment = process.env.FHEBC_OPERATION_ZK_AUTHORITY_COMMITMENT;
  if (!commitment || !ethers.isHexString(commitment, 32)) {
    throw new Error("Set FHEBC_OPERATION_ZK_AUTHORITY_COMMITMENT to the public Noir authority commitment.");
  }

  const generatedVerifier =
    process.env.FHEBC_NOIR_OPERATION_VERIFIER_ADDRESS ?? await deployGeneratedNoirOperationVerifier(txOverrides);
  const Adapter = await ethers.getContractFactory("NoirOperationProofVerifierAdapter");
  const adapter = await Adapter.deploy(generatedVerifier, commitment, txOverrides);
  await adapter.waitForDeployment();
  if (process.env.FHEBC_FREEZE_OPERATION_PROOF_ADAPTER !== "0") {
    await (await adapter.freezeConfiguration(txOverrides)).wait();
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    mode: "noir-operation-proof-adapter",
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    addresses: {
      noirOperationVerifier: generatedVerifier,
      operationProofVerifier: await adapter.getAddress()
    },
    authorityCommitment: commitment,
    frozen: await adapter.configurationFrozen()
  };

  const manifestPath = path.resolve(
    process.env.FHEBC_OPERATION_ADAPTER_MANIFEST ?? "runtime/deployments/noir-operation-proof-adapter.local.json"
  );
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log("=".repeat(78));
  console.log("BesuFHE Noir operation proof adapter deployment");
  console.log("=".repeat(78));
  console.log(`Network             : ${network.name} (chainId ${network.chainId})`);
  console.log(`Noir verifier       : ${generatedVerifier}`);
  console.log(`Operation adapter   : ${manifest.addresses.operationProofVerifier}`);
  console.log(`Authority commitment: ${commitment}`);
  console.log(`Manifest            : ${manifestPath}`);
  console.log("=".repeat(78));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
