// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Interfaccia di verifica per proof di validita' degli input.
/// @dev Il notary vincola il digest a chain id, notary address, owner, hash del ciphertext,
/// hash dei metadata, range e nonce. L'implementazione di produzione verifica proof ZK Groth16.
interface IInputProofVerifier {
    function verifyInputProof(bytes32 inputDigest, bytes calldata proof) external view returns (bool);
}
