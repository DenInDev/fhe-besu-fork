// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../lib/OnChainCiphertext.sol";

contract OnChainCiphertextHarness {
    using OnChainCiphertext for OnChainCiphertext.Blob;

    OnChainCiphertext.Blob private blob;

    function store(bytes calldata data) external {
        blob.write(data);
    }

    function load() external view returns (bytes memory) {
        return blob.read();
    }

    function info()
        external
        view
        returns (address manifest, uint256 ciphertextLength, uint256 chunkCount, bytes32 contentHash)
    {
        return blob.metadata();
    }
}
