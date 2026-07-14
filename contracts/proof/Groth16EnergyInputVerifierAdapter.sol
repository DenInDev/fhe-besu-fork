// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IInputProofVerifier.sol";
import "./IGroth16EnergyInputVerifier.sol";

/// @notice Adapter per proof Groth16 BN254 di validita' degli input cifrati.
/// @dev Payload ABI:
/// `(address,bytes32,bytes32,uint256,uint256,bytes32,uint256[2],uint256[2][2],uint256[2],uint256[6])`.
contract Groth16EnergyInputVerifierAdapter is IInputProofVerifier {
    bytes32 public constant VERIFIED_INPUT_TYPEHASH = keccak256("BESUFHE_VERIFIED_INPUT_V1");
    uint256 private constant LOW_128_MASK = type(uint128).max;
    uint256 private constant UINT64_MAX = type(uint64).max;
    uint256 private constant BN254_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    address public owner;
    IGroth16EnergyInputVerifier public verifier;
    bool public configurationFrozen;

    struct InputProofPayload {
        address inputOwner;
        bytes32 ciphertextHash;
        bytes32 zkMetadataHash;
        uint256 minValue;
        uint256 maxValue;
        bytes32 nonce;
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256[6] publicSignals;
    }

    error NotOwner(address caller);
    error ZeroAddress();
    error ConfigurationAlreadyFrozen();
    error ConfigurationIsFrozen();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event VerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event ConfigurationFrozen(address indexed owner, address indexed verifier);

    constructor(address initialVerifier) {
        if (initialVerifier == address(0)) {
            revert ZeroAddress();
        }
        owner = msg.sender;
        verifier = IGroth16EnergyInputVerifier(initialVerifier);
        emit OwnershipTransferred(address(0), msg.sender);
        emit VerifierUpdated(address(0), initialVerifier);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) {
            revert ZeroAddress();
        }
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setVerifier(address newVerifier) external onlyOwner {
        if (configurationFrozen) {
            revert ConfigurationIsFrozen();
        }
        if (newVerifier == address(0)) {
            revert ZeroAddress();
        }
        emit VerifierUpdated(address(verifier), newVerifier);
        verifier = IGroth16EnergyInputVerifier(newVerifier);
    }

    function freezeConfiguration() external onlyOwner {
        if (configurationFrozen) {
            revert ConfigurationAlreadyFrozen();
        }
        configurationFrozen = true;
        emit ConfigurationFrozen(msg.sender, address(verifier));
    }

    function verifyInputProof(bytes32 inputDigest, bytes calldata proof) external view returns (bool) {
        InputProofPayload memory payload = abi.decode(proof, (InputProofPayload));

        if (
            payload.minValue > payload.maxValue || payload.maxValue > UINT64_MAX
                || uint256(payload.zkMetadataHash) >= BN254_SCALAR_FIELD
        ) {
            return false;
        }

        bytes32 inputContextHash = keccak256(abi.encode(payload.zkMetadataHash, payload.minValue, payload.maxValue));
        bytes32 expectedDigest = keccak256(
            abi.encode(
                VERIFIED_INPUT_TYPEHASH,
                block.chainid,
                msg.sender,
                payload.inputOwner,
                payload.ciphertextHash,
                inputContextHash,
                payload.nonce
            )
        );
        if (expectedDigest != inputDigest) {
            return false;
        }

        uint256[6] memory expectedPublicSignals =
            publicSignals(
                payload.inputOwner,
                payload.ciphertextHash,
                payload.zkMetadataHash,
                payload.minValue,
                payload.maxValue
            );
        for (uint256 i = 0; i < expectedPublicSignals.length; i++) {
            if (
                payload.publicSignals[i] != expectedPublicSignals[i]
                    || payload.publicSignals[i] >= BN254_SCALAR_FIELD
            ) {
                return false;
            }
        }

        return verifier.verifyProof(payload.a, payload.b, payload.c, payload.publicSignals);
    }

    /// @notice Ordine public signals Groth16: ciphertextHashHi, ciphertextHashLo, owner, minValue, maxValue, metadataHash.
    function publicSignals(
        address inputOwner,
        bytes32 ciphertextHash,
        bytes32 zkMetadataHash,
        uint256 minValue,
        uint256 maxValue
    ) public pure returns (uint256[6] memory signals) {
        uint256 ciphertextHashValue = uint256(ciphertextHash);
        signals[0] = ciphertextHashValue >> 128;
        signals[1] = ciphertextHashValue & LOW_128_MASK;
        signals[2] = uint256(uint160(inputOwner));
        signals[3] = minValue;
        signals[4] = maxValue;
        signals[5] = uint256(zkMetadataHash);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert NotOwner(msg.sender);
        }
        _;
    }
}
