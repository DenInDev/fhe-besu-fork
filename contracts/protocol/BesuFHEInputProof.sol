// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./BesuFHEMiddleware.sol";

/// @notice Modulo opzionale a livello di protocollo per input cifrati esterni.
/// Verifica una prova ZK di validità dell’input, impedisce il replay, quindi
/// memorizza il ciphertext tramite il middleware generico BesuFHE.
abstract contract BesuFHEInputProof is BesuFHEMiddleware {
    error InvalidInputRange(uint256 minValue, uint256 maxValue);
    error InputProofAlreadyConsumed(bytes32 inputDigest);

    mapping(uint256 => bytes32) private inputProofDigests;
    mapping(bytes32 => bool) private consumedInputProofDigests;

    event FheInputProofAccepted(
        uint256 indexed ciphertextId,
        address indexed owner,
        bytes32 indexed inputDigest,
        bytes32 metadataHash,
        uint256 minValue,
        uint256 maxValue
    );

    function inputContextHash(bytes32 metadataHash, uint256 minValue, uint256 maxValue)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(metadataHash, minValue, maxValue));
    }

    function inputProofDigestForCiphertext(
        address owner,
        bytes32 ciphertextHash,
        bytes32 metadataHash,
        uint256 minValue,
        uint256 maxValue,
        bytes32 nonce
    ) public view returns (bytes32) {
        return _verifiedInputDigest(owner, ciphertextHash, inputContextHash(metadataHash, minValue, maxValue), nonce);
    }

    function getInputProofDigest(uint256 ciphertextId) external view returns (bytes32) {
        return inputProofDigests[ciphertextId];
    }

    function isInputProofDigestConsumed(bytes32 inputDigest) external view returns (bool) {
        return consumedInputProofDigests[inputDigest];
    }

    function _storeFheCiphertextWithInputProof(
        address owner,
        bytes calldata ciphertext,
        bytes32 metadataHash,
        uint256 minValue,
        uint256 maxValue,
        bytes32 nonce,
        bytes calldata inputProof
    ) internal returns (uint256 ciphertextId, bytes32 inputDigest) {
        if (minValue > maxValue) {
            revert InvalidInputRange(minValue, maxValue);
        }

        inputDigest =
            inputProofDigestForCiphertext(owner, keccak256(ciphertext), metadataHash, minValue, maxValue, nonce);
        if (consumedInputProofDigests[inputDigest]) {
            revert InputProofAlreadyConsumed(inputDigest);
        }

        _verifyInputProof(inputDigest, inputProof);
        consumedInputProofDigests[inputDigest] = true;

        ciphertextId = _storeFheCiphertext(owner, ciphertext, metadataHash);
        inputProofDigests[ciphertextId] = inputDigest;

        emit FheInputProofAccepted(ciphertextId, owner, inputDigest, metadataHash, minValue, maxValue);
    }
}
