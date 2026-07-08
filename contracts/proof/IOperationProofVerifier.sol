// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Verifier boundary for proof-backed homomorphic operations.
/// @dev The operation digest is domain-separated by the protocol contract and
/// already binds chain id, contract address, owner, operation, input hashes,
/// result hash and nonce.
interface IOperationProofVerifier {
    function verifyOperationProof(bytes32 operationDigest, bytes calldata proof) external view returns (bool);
}
