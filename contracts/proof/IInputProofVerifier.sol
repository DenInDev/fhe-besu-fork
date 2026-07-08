// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Verifier boundary for input-validity proofs.
/// @dev The notary binds the digest to chain id, notary, owner, ciphertext hash,
/// metadata hash, range and nonce. The production implementation verifies
/// Noir/Barretenberg ZK proofs. A signed certificate verifier can still be used
/// as a local development fallback.
interface IInputProofVerifier {
    function verifyInputProof(bytes32 inputDigest, bytes calldata proof) external view returns (bool);
}
