// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Interfaccia di verifica per proof di validità degli input.
/// @dev Il notary vincola il digest a chain id, notary address, owner, hash del ciphertext,
/// hash dei metadata, range e nonce. L’implementazione di produzione verifica
/// prove ZK Noir/Barretenberg. Un verifier basato su certificati firmati può comunque
/// essere usato come fallback per lo sviluppo locale.
interface IInputProofVerifier {
    function verifyInputProof(bytes32 inputDigest, bytes calldata proof) external view returns (bool);
}
