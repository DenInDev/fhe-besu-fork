const fs = require("node:fs");
const path = require("node:path");
const {
  profile,
  rewriteGeneratedVerifier,
  root,
  runCircom,
  runSnarkjs,
} = require("./utils");

const profileName = process.argv[2];
if (!profileName) {
  throw new Error("Usage: node scripts/proof/groth16/build.js <energy-input|operation-authority>");
}

const selected = profile(profileName);
const power = process.env.FHEBC_GROTH16_PTAU_POWER ?? "16";
const force = process.env.FHEBC_GROTH16_FORCE === "1";
const ptauDir = path.join(root, "proof", "groth16", "ptau");
const pot0 = path.join(ptauDir, `pot${power}_0000.ptau`);
const pot1 = path.join(ptauDir, `pot${power}_0001.ptau`);
const potFinal = path.join(ptauDir, `pot${power}_final.ptau`);

function ensurePtau() {
  fs.mkdirSync(ptauDir, { recursive: true });
  if (!force && fs.existsSync(potFinal)) {
    return;
  }
  console.log(`Generating local Powers of Tau file: ${path.relative(root, potFinal)}`);
  runSnarkjs(["powersoftau", "new", "bn128", power, path.relative(root, pot0), "-v"], { stdio: "inherit" });
  runSnarkjs(
    [
      "powersoftau",
      "contribute",
      path.relative(root, pot0),
      path.relative(root, pot1),
      "--name=BesuFHE local Groth16 ptau",
      "-e=besufhe-local-entropy",
      "-v",
    ],
    { stdio: "inherit" }
  );
  runSnarkjs(
    ["powersoftau", "prepare", "phase2", path.relative(root, pot1), path.relative(root, potFinal), "-v"],
    { stdio: "inherit" }
  );
}

function main() {
  fs.mkdirSync(selected.targetDir, { recursive: true });
  fs.mkdirSync(path.dirname(selected.generatedVerifierPath), { recursive: true });
  ensurePtau();

  console.log(`Compiling ${profileName} circuit...`);
  runCircom(selected.circuitPath, selected.targetDir);

  console.log(`Running Groth16 setup for ${profileName}...`);
  runSnarkjs(
    [
      "groth16",
      "setup",
      path.relative(root, selected.r1csPath),
      path.relative(root, potFinal),
      path.relative(root, selected.zkeyInitialPath),
    ],
    { stdio: "inherit" }
  );
  runSnarkjs(
    [
      "zkey",
      "contribute",
      path.relative(root, selected.zkeyInitialPath),
      path.relative(root, selected.zkeyFinalPath),
      "--name=BesuFHE Groth16 circuit contribution",
      "-e=besufhe-circuit-entropy",
      "-v",
    ],
    { stdio: "inherit" }
  );
  runSnarkjs(
    ["zkey", "export", "verificationkey", path.relative(root, selected.zkeyFinalPath), path.relative(root, selected.verificationKeyPath)],
    { stdio: "inherit" }
  );
  runSnarkjs(
    ["zkey", "export", "solidityverifier", path.relative(root, selected.zkeyFinalPath), path.relative(root, selected.generatedVerifierPath)],
    { stdio: "inherit" }
  );

  const generated = fs.readFileSync(selected.generatedVerifierPath, "utf8");
  fs.writeFileSync(
    selected.generatedVerifierPath,
    rewriteGeneratedVerifier(generated, selected.contractName, selected.pairingName)
  );

  console.log("\nGroth16 artifacts generated:");
  console.log(`  r1cs      : ${selected.r1csPath}`);
  console.log(`  wasm      : ${selected.wasmPath}`);
  console.log(`  zkey      : ${selected.zkeyFinalPath}`);
  console.log(`  verifier  : ${selected.generatedVerifierPath}`);
}

main();
