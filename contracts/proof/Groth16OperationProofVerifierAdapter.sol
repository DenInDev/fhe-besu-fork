// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IGroth16OperationVerifier.sol";
import "./IOperationProofVerifier.sol";

/// @notice Adapter Groth16 BN254 per operazioni FHE proof-backed.
/// @dev Payload ABI:
/// `(bytes32,bytes32,uint256[2],uint256[2][2],uint256[2],uint256[4])`.
contract Groth16OperationProofVerifierAdapter is IOperationProofVerifier {
    uint256 private constant LOW_128_MASK = type(uint128).max;
    uint256 private constant BN254_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    address public owner;
    IGroth16OperationVerifier public verifier;
    bytes32 public authorizedAuthorityCommitment;
    bool public configurationFrozen;

    struct OperationProofPayload {
        bytes32 authorityCommitment;
        bytes32 attestationHash;
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256[4] publicSignals;
    }

    error NotOwner(address caller);
    error ZeroAddress();
    error InvalidField(bytes32 value);
    error ConfigurationAlreadyFrozen();
    error ConfigurationIsFrozen();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event VerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event AuthorityCommitmentUpdated(bytes32 indexed previousCommitment, bytes32 indexed newCommitment);
    event ConfigurationFrozen(address indexed owner, address indexed verifier, bytes32 indexed authorityCommitment);

    constructor(address initialVerifier, bytes32 initialAuthorityCommitment) {
        if (initialVerifier == address(0)) {
            revert ZeroAddress();
        }
        _requireField(initialAuthorityCommitment);
        owner = msg.sender;
        verifier = IGroth16OperationVerifier(initialVerifier);
        authorizedAuthorityCommitment = initialAuthorityCommitment;
        emit OwnershipTransferred(address(0), msg.sender);
        emit VerifierUpdated(address(0), initialVerifier);
        emit AuthorityCommitmentUpdated(bytes32(0), initialAuthorityCommitment);
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
        verifier = IGroth16OperationVerifier(newVerifier);
    }

    function setAuthorizedAuthorityCommitment(bytes32 newAuthorityCommitment) external onlyOwner {
        if (configurationFrozen) {
            revert ConfigurationIsFrozen();
        }
        _requireField(newAuthorityCommitment);
        emit AuthorityCommitmentUpdated(authorizedAuthorityCommitment, newAuthorityCommitment);
        authorizedAuthorityCommitment = newAuthorityCommitment;
    }

    function freezeConfiguration() external onlyOwner {
        if (configurationFrozen) {
            revert ConfigurationAlreadyFrozen();
        }
        configurationFrozen = true;
        emit ConfigurationFrozen(msg.sender, address(verifier), authorizedAuthorityCommitment);
    }

    function verifyOperationProof(bytes32 operationDigest, bytes calldata proof) external view returns (bool) {
        OperationProofPayload memory payload = abi.decode(proof, (OperationProofPayload));

        if (
            payload.authorityCommitment != authorizedAuthorityCommitment
                || uint256(payload.attestationHash) >= BN254_SCALAR_FIELD
        ) {
            return false;
        }

        uint256[4] memory expectedPublicSignals =
            publicSignals(operationDigest, payload.authorityCommitment, payload.attestationHash);
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

    /// @notice Ordine public signals Groth16: operationDigestHi, operationDigestLo, authorityCommitment, attestationHash.
    function publicSignals(bytes32 operationDigest, bytes32 authorityCommitment, bytes32 attestationHash)
        public
        pure
        returns (uint256[4] memory signals)
    {
        uint256 digestValue = uint256(operationDigest);
        signals[0] = digestValue >> 128;
        signals[1] = digestValue & LOW_128_MASK;
        signals[2] = uint256(authorityCommitment);
        signals[3] = uint256(attestationHash);
    }

    function _requireField(bytes32 value) private pure {
        if (uint256(value) >= BN254_SCALAR_FIELD) {
            revert InvalidField(value);
        }
    }

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert NotOwner(msg.sender);
        }
        _;
    }
}
