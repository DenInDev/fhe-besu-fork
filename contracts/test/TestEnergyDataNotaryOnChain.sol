// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../EnergyDataNotaryOnChain.sol";

contract TestEnergyDataNotaryOnChain is EnergyDataNotaryOnChain {
    address private immutable mockPrecompile;

    constructor(address initialMockPrecompile) {
        mockPrecompile = initialMockPrecompile;
    }

    function _fhePrecompile() internal view override returns (address) {
        return mockPrecompile;
    }
}

