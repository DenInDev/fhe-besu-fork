// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../EnergyDataNotaryOnChain.sol";

/// @notice Test harness only. Production uses EnergyDataNotaryOnChain directly,
/// whose precompile address is hardcoded to 0x100.
contract TestEnergyDataNotaryOnChain is EnergyDataNotaryOnChain {
    address private immutable mockPrecompile;

    constructor(address initialMockPrecompile) {
        mockPrecompile = initialMockPrecompile;
    }

    function _fhePrecompile() internal view override returns (address) {
        return mockPrecompile;
    }
}

