import { expect } from "chai";
import { ethers } from "hardhat";

const INPUT_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("BESUFHE_VERIFIED_INPUT_V1"));
const AUTHORITY_COMMITMENT = ethers.toBeHex(123456789n, 32);

const proofA = [1n, 2n];
const proofB = [
  [3n, 4n],
  [5n, 6n],
];
const proofC = [7n, 8n];

function normalArray(values: readonly bigint[]) {
  return Array.from(values, (value) => BigInt(value.toString()));
}

describe("Groth16 proof adapters", function () {
  it("binds Groth16 input proofs to digest and public signals", async function () {
    const [caller, inputOwner] = await ethers.getSigners();
    const verifier: any = await ethers.deployContract("MockGroth16EnergyInputVerifier", [true]);
    await verifier.waitForDeployment();
    const adapter: any = await ethers.deployContract("Groth16EnergyInputVerifierAdapter", [
      await verifier.getAddress(),
    ]);
    await adapter.waitForDeployment();

    const ciphertext = ethers.AbiCoder.defaultAbiCoder().encode(["uint32"], [42]);
    const ciphertextHash = ethers.keccak256(ciphertext);
    const metadataHash = ethers.toBeHex(987654321n, 32);
    const minValue = 0n;
    const maxValue = 100n;
    const nonce = ethers.id("groth16-input");
    const inputContextHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256", "uint256"], [metadataHash, minValue, maxValue])
    );
    const network = await ethers.provider.getNetwork();
    const digest = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint256", "address", "address", "bytes32", "bytes32", "bytes32"],
        [INPUT_TYPEHASH, network.chainId, caller.address, inputOwner.address, ciphertextHash, inputContextHash, nonce]
      )
    );
    const publicSignals = normalArray(await adapter.publicSignals(
      inputOwner.address,
      ciphertextHash,
      metadataHash,
      minValue,
      maxValue
    ));
    await verifier.setExpectedPublicSignals(publicSignals);

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
        "uint256[6]",
      ],
      [
        inputOwner.address,
        ciphertextHash,
        metadataHash,
        minValue,
        maxValue,
        nonce,
        proofA,
        proofB,
        proofC,
        publicSignals,
      ]
    );

    expect(await adapter.connect(caller).verifyInputProof(digest, proof)).to.equal(true);

    const badSignals = Array.from(publicSignals);
    badSignals[3] = 1n;
    const badProof = ethers.AbiCoder.defaultAbiCoder().encode(
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
        "uint256[6]",
      ],
      [
        inputOwner.address,
        ciphertextHash,
        metadataHash,
        minValue,
        maxValue,
        nonce,
        proofA,
        proofB,
        proofC,
        badSignals,
      ]
    );
    expect(await adapter.connect(caller).verifyInputProof(digest, badProof)).to.equal(false);
  });

  it("binds Groth16 operation proofs to authorized authority and operation digest", async function () {
    const verifier: any = await ethers.deployContract("MockGroth16OperationVerifier", [true]);
    await verifier.waitForDeployment();
    const adapter: any = await ethers.deployContract("Groth16OperationProofVerifierAdapter", [
      await verifier.getAddress(),
      AUTHORITY_COMMITMENT,
    ]);
    await adapter.waitForDeployment();

    const operationDigest = ethers.id("operation-digest");
    const attestationHash = ethers.toBeHex(424242n, 32);
    const publicSignals = normalArray(await adapter.publicSignals(operationDigest, AUTHORITY_COMMITMENT, attestationHash));
    await verifier.setExpectedPublicSignals(publicSignals);

    const proof = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "uint256[2]", "uint256[2][2]", "uint256[2]", "uint256[4]"],
      [AUTHORITY_COMMITMENT, attestationHash, proofA, proofB, proofC, publicSignals]
    );
    expect(await adapter.verifyOperationProof(operationDigest, proof)).to.equal(true);

    const wrongAuthorityProof = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "uint256[2]", "uint256[2][2]", "uint256[2]", "uint256[4]"],
      [ethers.toBeHex(999n, 32), attestationHash, proofA, proofB, proofC, publicSignals]
    );
    expect(await adapter.verifyOperationProof(operationDigest, wrongAuthorityProof)).to.equal(false);
  });
});
