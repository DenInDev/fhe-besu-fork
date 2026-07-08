import fs from "node:fs";
import path from "node:path";
import { artifacts, ethers } from "hardhat";

async function main() {
  if (!(await artifacts.artifactExists("NoirEnergyInputGeneratedVerifier"))) {
    throw new Error(
      "NoirEnergyInputGeneratedVerifier artifact not found. Run `npm run proof:build:energy-input:noir` and `npm run compile` first."
    );
  }

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const gasPrice = BigInt(process.env.FHEBC_BESU_GAS_PRICE_WEI ?? "1000");
  const txOverrides = { gasLimit: 20_000_000n, gasPrice };

  console.log("=".repeat(78));
  console.log("Noir energy input generated verifier deployment");
  console.log("=".repeat(78));
  console.log(`Network  : ${network.name} (chainId ${network.chainId})`);
  console.log(`Deployer : ${deployer.address}`);

  const TranscriptLib = await ethers.getContractFactory("ZKTranscriptLib");
  const transcriptLib = await TranscriptLib.deploy(txOverrides);
  await transcriptLib.waitForDeployment();
  const transcriptLibAddress = await transcriptLib.getAddress();
  console.log(`ZKTranscriptLib deployed at: ${transcriptLibAddress}`);

  const Verifier = await ethers.getContractFactory("NoirEnergyInputGeneratedVerifier", {
    libraries: {
      ZKTranscriptLib: transcriptLibAddress
    }
  });
  const verifier = await Verifier.deploy(txOverrides);
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();

  const manifest = {
    generatedAt: new Date().toISOString(),
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    addresses: {
      zkTranscriptLib: transcriptLibAddress,
      noirEnergyInputGeneratedVerifier: verifierAddress
    }
  };
  const manifestPath = path.resolve(
    process.env.FHEBC_NOIR_INPUT_VERIFIER_MANIFEST ?? "deployments/fhebc-noir-input-verifier.local.json"
  );
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`NoirEnergyInputGeneratedVerifier deployed at: ${verifierAddress}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log("Next:");
  console.log(`  FHEBC_NOIR_INPUT_VERIFIER_ADDRESS=${verifierAddress} npm run deploy:besu`);
  console.log("=".repeat(78));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
