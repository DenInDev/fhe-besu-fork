import { ethers } from "hardhat";

async function main() {
  const generatedVerifier = process.env.FHEBC_NOIR_INPUT_VERIFIER_ADDRESS;
  if (!generatedVerifier) {
    throw new Error("Set FHEBC_NOIR_INPUT_VERIFIER_ADDRESS to the generated Noir verifier address.");
  }

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const gasPrice = BigInt(process.env.FHEBC_BESU_GAS_PRICE_WEI ?? "1000");
  const txOverrides = { gasLimit: 20_000_000n, gasPrice };
  const freezeConfig = process.env.FHEBC_FREEZE_INPUT_PROOF_CONFIG !== "0";

  console.log("=".repeat(78));
  console.log("Noir input-proof adapter deployment");
  console.log("=".repeat(78));
  console.log(`Network           : ${network.name} (chainId ${network.chainId})`);
  console.log(`Deployer          : ${deployer.address}`);
  console.log(`Generated verifier: ${generatedVerifier}`);
  console.log(`Freeze config     : ${freezeConfig ? "yes" : "no"}`);

  const Adapter = await ethers.getContractFactory("NoirEnergyInputVerifierAdapter");
  const adapter = await Adapter.deploy(generatedVerifier, txOverrides);
  await adapter.waitForDeployment();
  if (freezeConfig) {
    await (await adapter.freezeConfiguration(txOverrides)).wait();
  }

  console.log(`NoirEnergyInputVerifierAdapter deployed at: ${await adapter.getAddress()}`);
  console.log("Use this address as FHEBC_INPUT_PROOF_VERIFIER_ADDRESS when deploying the notary.");
  console.log("=".repeat(78));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
