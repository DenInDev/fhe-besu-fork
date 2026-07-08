// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Interfaccia per la verifica di operazioni omomorfiche supportate da proof.
/// @dev Il digest dell’operazione è separato per dominio dal contratto di protocollo e
/// vincola già chain id, indirizzo del contratto, owner, operazione, hash degli input,
/// hash del risultato e nonce.
interface IOperationProofVerifier {
    function verifyOperationProof(bytes32 operationDigest, bytes calldata proof) external view returns (bool);
}
