import { expect } from "chai";
import { ethers } from "hardhat";

function encU32(value: number) {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint32"], [value]);
}

function decU32(ciphertext: string) {
  return Number(ethers.AbiCoder.defaultAbiCoder().decode(["uint32"], ciphertext)[0]);
}

describe("EnergyDataNotaryOnChain", function () {
  const OPERATION_AUTHORITY_COMMITMENT = ethers.toBeHex(123456789n, 32);

  async function fixture() {
    const Mock = await ethers.getContractFactory("MockFhePrecompile");
    const mock = await Mock.deploy();
    await mock.waitForDeployment();

    const [owner, other] = await ethers.getSigners();
    const Notary = await ethers.getContractFactory("TestEnergyDataNotaryOnChain");
    const notary: any = await Notary.deploy(await mock.getAddress());
    await notary.waitForDeployment();

    const GeneratedVerifier = await ethers.getContractFactory("MockGroth16EnergyInputVerifier");
    const generatedVerifier: any = await GeneratedVerifier.deploy(true);
    await generatedVerifier.waitForDeployment();

    const Adapter = await ethers.getContractFactory("Groth16EnergyInputVerifierAdapter");
    const adapter: any = await Adapter.deploy(await generatedVerifier.getAddress());
    await adapter.waitForDeployment();
    await notary.setInputProofVerifier(await adapter.getAddress());

    const OperationGeneratedVerifier = await ethers.getContractFactory("MockGroth16OperationVerifier");
    const operationGeneratedVerifier: any = await OperationGeneratedVerifier.deploy(true);
    await operationGeneratedVerifier.waitForDeployment();

    const OperationAdapter = await ethers.getContractFactory("Groth16OperationProofVerifierAdapter");
    const operationAdapter: any = await OperationAdapter.deploy(
      await operationGeneratedVerifier.getAddress(),
      OPERATION_AUTHORITY_COMMITMENT
    );
    await operationAdapter.waitForDeployment();
    await notary.setOperationProofVerifier(await operationAdapter.getAddress());

    async function inputProof(
      ciphertext: string,
      metadataSeed: bigint,
      minValue: number,
      maxValue: number,
      nonceLabel: string,
      inputOwner = owner.address
    ) {
      const ciphertextHash = ethers.keccak256(ciphertext);
      const metadataHash = ethers.toBeHex(metadataSeed, 32);
      const nonce = ethers.id(nonceLabel);
      const digest = await notary.inputProofDigestForCiphertext(
        inputOwner,
        ciphertextHash,
        metadataHash,
        minValue,
        maxValue,
        nonce
      );
      const rawPublicInputs = await adapter.publicSignals(inputOwner, ciphertextHash, metadataHash, minValue, maxValue);
      const publicInputs = Array.from(rawPublicInputs);
      await generatedVerifier.setExpectedPublicSignals(publicInputs);

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
          inputOwner,
          ciphertextHash,
          metadataHash,
          minValue,
          maxValue,
          nonce,
          [0, 0],
          [
            [0, 0],
            [0, 0]
          ],
          [0, 0],
          publicInputs
        ]
      );

      return { metadataHash, minValue, maxValue, nonce, proof, digest };
    }

    async function operationProof(
      kind: number,
      inputSetHash: string,
      output: string,
      nonceLabel: string,
      proofOwner = owner.address
    ) {
      const nonce = ethers.id(nonceLabel);
      const digest = await notary.operationProofDigest(
        proofOwner,
        kind,
        inputSetHash,
        ethers.keccak256(output),
        ethers.ZeroHash,
        nonce
      );
      const attestationHash = ethers.toBeHex(BigInt(ethers.id(`${nonceLabel}:attestation`)) % (1n << 128n), 32);
      const rawPublicInputs = await operationAdapter.publicSignals(
        digest,
        OPERATION_AUTHORITY_COMMITMENT,
        attestationHash
      );
      const publicInputs = Array.from(rawPublicInputs);
      await operationGeneratedVerifier.setExpectedPublicSignals(publicInputs);
      const proof = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "uint256[2]", "uint256[2][2]", "uint256[2]", "uint256[4]"],
        [
          OPERATION_AUTHORITY_COMMITMENT,
          attestationHash,
          [0, 0],
          [
            [0, 0],
            [0, 0]
          ],
          [0, 0],
          publicInputs
        ]
      );
      return { nonce, proof, digest };
    }

    return { owner, other, notary, inputProof, operationProof };
  }

  it("stores a single-chunk ciphertext without a separate manifest contract", async function () {
    const harness: any = await ethers.deployContract("OnChainCiphertextHarness");
    await harness.waitForDeployment();
    const ciphertext = ethers.hexlify(ethers.randomBytes(1024));

    await harness.store(ciphertext);

    const storage = await harness.info();
    expect(storage.ciphertextLength).to.equal(1024);
    expect(storage.chunkCount).to.equal(1);
    expect(storage.contentHash).to.equal(ethers.keccak256(ciphertext));
    expect(await harness.load()).to.equal(ciphertext);

    const runtimeCode = await ethers.provider.getCode(storage.manifest);
    expect(runtimeCode).to.equal(`0x00${ciphertext.slice(2)}`);
  });

  it("keeps a compact address manifest for multi-chunk ciphertexts", async function () {
    const harness: any = await ethers.deployContract("OnChainCiphertextHarness");
    await harness.waitForDeployment();
    const ciphertext = ethers.hexlify(new Uint8Array(24_576).fill(0x5a));

    await harness.store(ciphertext, { gasLimit: 15_000_000 });

    const storage = await harness.info();
    expect(storage.ciphertextLength).to.equal(24_576);
    expect(storage.chunkCount).to.equal(2);
    expect(storage.contentHash).to.equal(ethers.keccak256(ciphertext));
    expect(await harness.load()).to.equal(ciphertext);

    const manifestCode = await ethers.provider.getCode(storage.manifest);
    expect(ethers.getBytes(manifestCode).length).to.equal(41);
  });

  it("stores only the latest energy entry for the benchmark surface", async function () {
    const { owner, notary, inputProof } = await fixture();
    const first = encU32(42);
    const second = encU32(99);
    const firstProof = await inputProof(first, 101n, 0, 100, "entry-first");

    await expect(
      notary.addEnergyEntry(
        first,
        firstProof.metadataHash,
        firstProof.minValue,
        firstProof.maxValue,
        firstProof.nonce,
        firstProof.proof
      )
    )
      .to.emit(notary, "EnergyEntryAdded")
      .withArgs(owner.address, 1, ethers.keccak256(first), 32);
    expect(await notary.getEntryCount()).to.equal(1);
    expect(decU32(await notary.getLastEntryValue())).to.equal(42);

    const secondProof = await inputProof(second, 102n, 0, 100, "entry-second");
    await expect(
      notary.addEnergyEntry(
        second,
        secondProof.metadataHash,
        secondProof.minValue,
        secondProof.maxValue,
        secondProof.nonce,
        secondProof.proof
      )
    )
      .to.emit(notary, "EnergyEntryAdded")
      .withArgs(owner.address, 2, ethers.keccak256(second), 32);
    expect(await notary.getEntryCount()).to.equal(1);
    expect(decU32(await notary.getLastEntryValue())).to.equal(99);

    const storage = await notary.getLastEntryCiphertextStorage();
    expect(storage.ciphertextLength).to.equal(32);
    expect(storage.contentHash).to.equal(ethers.keccak256(second));
  });

  it("accepts a ZK input-validity proof before storing an external energy entry", async function () {
    const { owner, notary, inputProof } = await fixture();
    const ciphertext = encU32(42);
    const prepared = await inputProof(ciphertext, 123n, 1, 100, "input-proof-nonce");

    await expect(
      notary.addEnergyEntry(
        ciphertext,
        prepared.metadataHash,
        prepared.minValue,
        prepared.maxValue,
        prepared.nonce,
        prepared.proof
      )
    )
      .to.emit(notary, "FheInputProofAccepted")
      .withArgs(1, owner.address, prepared.digest, prepared.metadataHash, prepared.minValue, prepared.maxValue);

    expect(await notary.isInputProofDigestConsumed(prepared.digest)).to.equal(true);
    expect(decU32(await notary.getLastEntryValue())).to.equal(42);

    await expect(
      notary.addEnergyEntry(
        ciphertext,
        prepared.metadataHash,
        prepared.minValue,
        prepared.maxValue,
        prepared.nonce,
        prepared.proof
      )
    )
      .to.be.revertedWithCustomError(notary, "InputProofAlreadyConsumed")
      .withArgs(prepared.digest);
  });

  it("runs native linear operations and proof-backed aggregate operations", async function () {
    const { owner, notary, inputProof, operationProof } = await fixture();
    const initialTotal = encU32(10);
    const entry = encU32(42);
    const initialProof = await inputProof(initialTotal, 201n, 10, 10, "initial-total");

    await expect(
      notary.initializeEncryptedTotal(
        initialTotal,
        initialProof.metadataHash,
        initialProof.minValue,
        initialProof.maxValue,
        initialProof.nonce,
        initialProof.proof
      )
    )
      .to.emit(notary, "EncryptedTotalInitialized")
      .withArgs(owner.address, 1, ethers.keccak256(encU32(10)), 32);

    const entryProof = await inputProof(entry, 202n, 0, 100, "benchmark-entry");
    await notary.addEnergyEntry(
      entry,
      entryProof.metadataHash,
      entryProof.minValue,
      entryProof.maxValue,
      entryProof.nonce,
      entryProof.proof
    );

    expect(decU32(await notary.getEncryptedTotal())).to.equal(10);
    expect(decU32(await notary.previewAddLastEntryToEncryptedTotal())).to.equal(52);

    await expect(notary.addLastEntryToEncryptedTotal())
      .to.emit(notary, "EnergyOperationExecuted")
      .withArgs(owner.address, 0, 3, ethers.keccak256(encU32(52)), 32);
    expect(decU32(await notary.getEncryptedTotal())).to.equal(52);

    expect(decU32(await notary.previewMultiplyLastEntryByConstant(3))).to.equal(126);
    await expect(notary.multiplyLastEntryByConstant(3))
      .to.emit(notary, "EnergyOperationExecuted")
      .withArgs(owner.address, 2, 4, ethers.keccak256(encU32(126)), 32);
    expect(decU32(await notary.getLastResult())).to.equal(126);

    const inputSetHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32"],
        [ethers.keccak256(entry), ethers.keccak256(encU32(52))]
      )
    );

    const meanOutput = encU32(47);
    const meanProof = await operationProof(6, inputSetHash, meanOutput, "mean-proof");
    await expect(notary.meanLastEntryAndEncryptedTotalProof(meanOutput, meanProof.nonce, meanProof.proof))
      .to.emit(notary, "FheOperationProofAccepted")
      .withArgs(3, 6, owner.address, meanProof.digest, inputSetHash, ethers.keccak256(meanOutput), ethers.ZeroHash)
      .to.emit(notary, "EnergyOperationExecuted")
      .withArgs(owner.address, 6, 5, ethers.keccak256(meanOutput), 32);
    expect(decU32(await notary.getLastResult())).to.equal(47);
    expect(await notary.isOperationProofDigestConsumed(meanProof.digest)).to.equal(true);

    await expect(notary.meanLastEntryAndEncryptedTotalProof(meanOutput, meanProof.nonce, meanProof.proof))
      .to.be.revertedWithCustomError(notary, "OperationProofAlreadyConsumed")
      .withArgs(meanProof.digest);

    const maxOutput = encU32(52);
    const maxProof = await operationProof(7, inputSetHash, maxOutput, "max-proof");
    await expect(notary.maxLastEntryAndEncryptedTotalProof(maxOutput, maxProof.nonce, maxProof.proof))
      .to.emit(notary, "EnergyOperationExecuted")
      .withArgs(owner.address, 7, 6, ethers.keccak256(maxOutput), 32);
    expect(decU32(await notary.getLastResult())).to.equal(52);
  });

  it("runs the full lightweight proof-backed operation surface", async function () {
    const { owner, notary, inputProof, operationProof } = await fixture();
    const initialTotal = encU32(10);
    const entry = encU32(42);
    const initialProof = await inputProof(initialTotal, 401n, 10, 10, "pb-initial-total");
    await notary.initializeEncryptedTotal(
      initialTotal,
      initialProof.metadataHash,
      initialProof.minValue,
      initialProof.maxValue,
      initialProof.nonce,
      initialProof.proof
    );

    const entryProof = await inputProof(entry, 402n, 0, 100, "pb-entry");
    await notary.addEnergyEntry(
      entry,
      entryProof.metadataHash,
      entryProof.minValue,
      entryProof.maxValue,
      entryProof.nonce,
      entryProof.proof
    );

    const initialInputSetHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32"],
        [ethers.keccak256(entry), ethers.keccak256(initialTotal)]
      )
    );
    const addOutput = encU32(52);
    const addProof = await operationProof(0, initialInputSetHash, addOutput, "pb-add");
    await expect(notary.addLastEntryToEncryptedTotalProof(addOutput, addProof.nonce, addProof.proof))
      .to.emit(notary, "EnergyOperationExecuted")
      .withArgs(owner.address, 0, 3, ethers.keccak256(addOutput), 32);
    expect(decU32(await notary.getEncryptedTotal())).to.equal(52);

    const scalarInputSetHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "uint64"],
        [ethers.keccak256(entry), entryProof.metadataHash, 3]
      )
    );
    const mulOutput = encU32(126);
    const mulProof = await operationProof(2, scalarInputSetHash, mulOutput, "pb-mul");
    await expect(notary.multiplyLastEntryByConstantProof(3, mulOutput, mulProof.nonce, mulProof.proof))
      .to.emit(notary, "EnergyOperationExecuted")
      .withArgs(owner.address, 2, 4, ethers.keccak256(mulOutput), 32);
    expect(decU32(await notary.getLastResult())).to.equal(126);

    const aggregateInputSetHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32"],
        [ethers.keccak256(entry), ethers.keccak256(addOutput)]
      )
    );
    const meanOutput = encU32(47);
    const meanProof = await operationProof(6, aggregateInputSetHash, meanOutput, "pb-mean");
    await expect(notary.meanLastEntryAndEncryptedTotalProof(meanOutput, meanProof.nonce, meanProof.proof))
      .to.emit(notary, "EnergyOperationExecuted")
      .withArgs(owner.address, 6, 5, ethers.keccak256(meanOutput), 32);
    expect(decU32(await notary.getLastResult())).to.equal(47);

    await expect(notary.meanLastEntryAndEncryptedTotalProof(meanOutput, meanProof.nonce, meanProof.proof))
      .to.be.revertedWithCustomError(notary, "OperationProofAlreadyConsumed")
      .withArgs(meanProof.digest);

    const maxOutput = encU32(52);
    const maxProof = await operationProof(7, aggregateInputSetHash, maxOutput, "pb-max");
    await expect(notary.maxLastEntryAndEncryptedTotalProof(maxOutput, maxProof.nonce, maxProof.proof))
      .to.emit(notary, "EnergyOperationExecuted")
      .withArgs(owner.address, 7, 6, ethers.keccak256(maxOutput), 32);
    expect(decU32(await notary.getLastResult())).to.equal(52);
  });

  it("accepts a ZK operation-proof adapter for proof-backed results", async function () {
    const { owner, notary, inputProof } = await fixture();

    const zkVerifier = await ethers.deployContract("MockGroth16OperationVerifier", [true]);
    await zkVerifier.waitForDeployment();
    const authorityCommitment = ethers.toBeHex(123456789n, 32);
    const operationAdapter = await ethers.deployContract("Groth16OperationProofVerifierAdapter", [
      await zkVerifier.getAddress(),
      authorityCommitment,
    ]);
    await operationAdapter.waitForDeployment();
    await notary.setOperationProofVerifier(await operationAdapter.getAddress());

    const initialTotal = encU32(10);
    const entry = encU32(42);
    const initialProof = await inputProof(initialTotal, 501n, 10, 10, "zkop-initial-total");
    await notary.initializeEncryptedTotal(
      initialTotal,
      initialProof.metadataHash,
      initialProof.minValue,
      initialProof.maxValue,
      initialProof.nonce,
      initialProof.proof
    );
    const entryProof = await inputProof(entry, 502n, 0, 100, "zkop-entry");
    await notary.addEnergyEntry(
      entry,
      entryProof.metadataHash,
      entryProof.minValue,
      entryProof.maxValue,
      entryProof.nonce,
      entryProof.proof
    );

    await notary.addLastEntryToEncryptedTotal();
    const aggregateInputSetHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32"],
        [ethers.keccak256(entry), ethers.keccak256(encU32(52))]
      )
    );

    const meanOutput = encU32(47);
    const nonce = ethers.id("zkop-mean");
    const digest = await notary.operationProofDigest(
      owner.address,
      6,
      aggregateInputSetHash,
      ethers.keccak256(meanOutput),
      ethers.ZeroHash,
      nonce
    );
    const attestationHash = ethers.toBeHex(987654321n, 32);
    const rawPublicInputs = await operationAdapter.publicSignals(digest, authorityCommitment, attestationHash);
    const publicInputs = Array.from(rawPublicInputs);
    await zkVerifier.setExpectedPublicSignals(publicInputs);
    const zkOperationProof = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "uint256[2]", "uint256[2][2]", "uint256[2]", "uint256[4]"],
      [
        authorityCommitment,
        attestationHash,
        [0, 0],
        [
          [0, 0],
          [0, 0]
        ],
        [0, 0],
        publicInputs
      ]
    );

    await expect(notary.meanLastEntryAndEncryptedTotalProof(meanOutput, nonce, zkOperationProof))
      .to.emit(notary, "FheOperationProofAccepted")
      .withArgs(2, 6, owner.address, digest, aggregateInputSetHash, ethers.keccak256(meanOutput), ethers.ZeroHash);
    expect(await notary.isOperationProofDigestConsumed(digest)).to.equal(true);
    expect(decU32(await notary.getLastResult())).to.equal(47);

    await expect(notary.meanLastEntryAndEncryptedTotalProof(meanOutput, nonce, zkOperationProof))
      .to.be.revertedWithCustomError(notary, "OperationProofAlreadyConsumed")
      .withArgs(digest);
  });

  it("keeps benchmark state isolated by account", async function () {
    const { other, notary, inputProof } = await fixture();
    const initialProof = await inputProof(encU32(1), 301n, 1, 1, "isolated-total");

    await notary.initializeEncryptedTotal(
      encU32(1),
      initialProof.metadataHash,
      initialProof.minValue,
      initialProof.maxValue,
      initialProof.nonce,
      initialProof.proof
    );

    const entryProof = await inputProof(encU32(2), 302n, 0, 10, "isolated-entry");
    await notary.addEnergyEntry(
      encU32(2),
      entryProof.metadataHash,
      entryProof.minValue,
      entryProof.maxValue,
      entryProof.nonce,
      entryProof.proof
    );

    await expect(notary.connect(other).getLastEntryValue())
      .to.be.revertedWithCustomError(notary, "MissingLastEntry")
      .withArgs(other.address);
    await expect(notary.connect(other).addLastEntryToEncryptedTotal())
      .to.be.revertedWithCustomError(notary, "MissingLastEntry")
      .withArgs(other.address);
  });
});
