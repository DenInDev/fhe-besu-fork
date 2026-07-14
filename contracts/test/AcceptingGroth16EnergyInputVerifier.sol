// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../proof/IGroth16EnergyInputVerifier.sol";

/// @notice Test-only verifier che accetta qualsiasi proof Groth16.
/// @dev Usato solo per isolare il carico on-chain del notary nei benchmark sostenuti.
contract AcceptingGroth16EnergyInputVerifier is IGroth16EnergyInputVerifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[6] calldata
    ) external pure returns (bool) {
        return true;
    }
}
