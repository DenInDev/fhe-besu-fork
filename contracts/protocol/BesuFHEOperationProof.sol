// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../proof/IOperationProofVerifier.sol";
import "./BesuFHEInputProof.sol";

/// @notice Modulo di protocollo opzionale per la gestione dei risultati di operazioni proof-backed.
/// Verifica una prova di operazione, impedisce il replay, quindi memorizza il ciphertext risultante 
/// tramite il middleware generico BesuFHE.
abstract contract BesuFHEOperationProof is BesuFHEInputProof {
    error OperationProofVerifierNotConfigured();
    error InvalidOperationProof(bytes32 operationDigest);
    error OperationProofAlreadyConsumed(bytes32 operationDigest);
    error OperationProofConfigurationAlreadyFrozen();
    error OperationProofConfigurationIsFrozen();

    bytes32 public constant VERIFIED_OPERATION_TYPEHASH = keccak256("BESUFHE_VERIFIED_OPERATION_V1");

    IOperationProofVerifier public operationProofVerifier;
    bool public operationProofConfigurationFrozen;

    mapping(uint256 operationId => bytes32 operationDigest) private operationProofDigests;
    mapping(bytes32 operationDigest => bool consumed) private consumedOperationProofDigests;

    event OperationProofVerifierUpdated(address indexed verifier);
    event OperationProofConfigurationFrozen(address indexed admin, address indexed verifier);
    event FheOperationProofAccepted(
        uint256 indexed operationId,
        OperationKind indexed kind,
        address indexed owner,
        bytes32 operationDigest,
        bytes32 inputSetHash,
        bytes32 resultCiphertextHash,
        bytes32 resultMetadataHash
    );

    function setOperationProofVerifier(address newVerifier) external {
        if (msg.sender != proofAdmin) {
            revert NotProofAdmin(msg.sender);
        }
        if (operationProofConfigurationFrozen) {
            revert OperationProofConfigurationIsFrozen();
        }
        if (newVerifier == address(0)) {
            revert ZeroAddress();
        }
        operationProofVerifier = IOperationProofVerifier(newVerifier);
        emit OperationProofVerifierUpdated(newVerifier);
    }

    function freezeOperationProofConfiguration() external {
        if (msg.sender != proofAdmin) {
            revert NotProofAdmin(msg.sender);
        }
        if (operationProofConfigurationFrozen) {
            revert OperationProofConfigurationAlreadyFrozen();
        }
        if (address(operationProofVerifier) == address(0)) {
            revert OperationProofVerifierNotConfigured();
        }
        operationProofConfigurationFrozen = true;
        emit OperationProofConfigurationFrozen(msg.sender, address(operationProofVerifier));
    }

    function operationProofDigest(
        address owner,
        OperationKind kind,
        bytes32 inputSetHash,
        bytes32 resultCiphertextHash,
        bytes32 resultMetadataHash,
        bytes32 nonce
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                VERIFIED_OPERATION_TYPEHASH,
                block.chainid,
                address(this),
                owner,
                kind,
                inputSetHash,
                resultCiphertextHash,
                resultMetadataHash,
                nonce
            )
        );
    }

    function getOperationProofDigest(uint256 operationId) external view returns (bytes32) {
        return operationProofDigests[operationId];
    }

    function isOperationProofDigestConsumed(bytes32 digest) external view returns (bool) {
        return consumedOperationProofDigests[digest];
    }

    function _storeFheOperationWithProof(
        OperationKind kind,
        address owner,
        bytes memory output,
        bytes32 inputSetHash,
        bytes32 resultMetadataHash,
        bytes32 nonce,
        bytes calldata operationProof
    ) internal returns (uint256 operationId, bytes32 digest) {
        bytes32 resultCiphertextHash = keccak256(output);
        digest = operationProofDigest(owner, kind, inputSetHash, resultCiphertextHash, resultMetadataHash, nonce);

        if (consumedOperationProofDigests[digest]) {
            revert OperationProofAlreadyConsumed(digest);
        }
        _verifyOperationProof(digest, operationProof);
        consumedOperationProofDigests[digest] = true;

        operationId = _storeFheOperationWithMetadata(kind, owner, output, inputSetHash, resultMetadataHash);
        operationProofDigests[operationId] = digest;

        emit FheOperationProofAccepted(
            operationId,
            kind,
            owner,
            digest,
            inputSetHash,
            resultCiphertextHash,
            resultMetadataHash
        );
    }

    function _verifyOperationProof(bytes32 digest, bytes calldata operationProof) internal view {
        if (address(operationProofVerifier) == address(0)) {
            revert OperationProofVerifierNotConfigured();
        }
        if (!operationProofVerifier.verifyOperationProof(digest, operationProof)) {
            revert InvalidOperationProof(digest);
        }
    }
}
