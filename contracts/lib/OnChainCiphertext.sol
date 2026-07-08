// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Stores immutable byte arrays in contract runtime code.
/// Each data contract starts with STOP (0x00), followed by up to 24,575 bytes.
/// A compact manifest contract contains the ordered 20-byte chunk addresses.
library OnChainCiphertext {
    uint256 internal constant MAX_CHUNK_BYTES = 24_575;
    uint256 private constant MAX_MANIFEST_CHUNKS = MAX_CHUNK_BYTES / 20;
    uint256 private constant DATA_OFFSET = 1;
    uint256 private constant CREATE_PREFIX_BYTES = 10;

    struct Blob {
        address manifest;
        uint32 length;
        uint16 chunkCount;
        bytes32 contentHash;
    }

    error EmptyBlob();
    error BlobTooLarge(uint256 length);
    error TooManyChunks(uint256 count);
    error DeploymentFailed();
    error InvalidManifest(address manifest);
    error InvalidChunk(address chunk, uint256 expectedSize, uint256 actualSize);

    function write(Blob storage blob, bytes memory data) internal {
        uint256 length = data.length;
        if (length == 0) revert EmptyBlob();
        if (length > type(uint32).max) revert BlobTooLarge(length);

        uint256 chunkCount = (length + MAX_CHUNK_BYTES - 1) / MAX_CHUNK_BYTES;
        if (chunkCount > MAX_MANIFEST_CHUNKS) revert TooManyChunks(chunkCount);

        bytes memory manifestData = _allocateWithCopySlack(chunkCount * 20);
        uint256 offset;
        for (uint256 i = 0; i < chunkCount; i++) {
            uint256 chunkLength = _min(MAX_CHUNK_BYTES, length - offset);
            address chunk = _deployData(data, offset, chunkLength);
            assembly ("memory-safe") {
                mstore(add(add(manifestData, 0x20), mul(i, 20)), shl(96, chunk))
            }
            offset += chunkLength;
        }

        blob.manifest = _deployData(manifestData, 0, manifestData.length);
        blob.length = uint32(length);
        blob.chunkCount = uint16(chunkCount);
        blob.contentHash = keccak256(data);
    }

    function read(Blob storage blob) internal view returns (bytes memory data) {
        uint256 length = blob.length;
        uint256 chunkCount = blob.chunkCount;
        address manifest = blob.manifest;
        if (length == 0 || chunkCount == 0 || manifest == address(0)) revert EmptyBlob();

        bytes memory chunkAddresses = _readManifest(manifest, chunkCount);
        data = new bytes(length);
        uint256 written;
        for (uint256 i = 0; i < chunkCount; i++) {
            uint256 chunkLength = _min(MAX_CHUNK_BYTES, length - written);
            _copyChunk(data, _addressAt(chunkAddresses, i), written, chunkLength);
            written += chunkLength;
        }
    }

    function metadata(Blob storage blob)
        internal
        view
        returns (address manifest, uint256 length, uint256 chunkCount, bytes32 contentHash)
    {
        return (blob.manifest, blob.length, blob.chunkCount, blob.contentHash);
    }

    function _deployData(bytes memory data, uint256 offset, uint256 length) private returns (address pointer) {
        uint256 runtimeLength = DATA_OFFSET + length;
        uint256 creationLength = CREATE_PREFIX_BYTES + runtimeLength;
        bytes memory creationCode = _allocateWithCopySlack(creationLength);

        creationCode[0] = 0x61;
        creationCode[1] = bytes1(uint8(runtimeLength >> 8));
        creationCode[2] = bytes1(uint8(runtimeLength));
        creationCode[3] = 0x80;
        creationCode[4] = 0x60;
        creationCode[5] = bytes1(uint8(CREATE_PREFIX_BYTES));
        creationCode[6] = 0x3d;
        creationCode[7] = 0x39;
        creationCode[8] = 0x3d;
        creationCode[9] = 0xf3;
        creationCode[10] = 0x00;

        _copy(data, offset, creationCode, CREATE_PREFIX_BYTES + DATA_OFFSET, length);

        assembly ("memory-safe") {
            pointer := create(0, add(creationCode, 0x20), mload(creationCode))
        }
        if (pointer == address(0)) revert DeploymentFailed();
    }

    function _readManifest(address manifest, uint256 chunkCount) private view returns (bytes memory chunkAddresses) {
        uint256 expectedSize = DATA_OFFSET + chunkCount * 20;
        uint256 actualSize;
        assembly ("memory-safe") {
            actualSize := extcodesize(manifest)
        }
        if (actualSize != expectedSize) revert InvalidManifest(manifest);

        chunkAddresses = new bytes(chunkCount * 20);
        assembly ("memory-safe") {
            extcodecopy(manifest, add(chunkAddresses, 0x20), DATA_OFFSET, mul(chunkCount, 20))
        }
    }

    function _addressAt(bytes memory addresses, uint256 index) private pure returns (address value) {
        assembly ("memory-safe") {
            value := shr(96, mload(add(add(addresses, 0x20), mul(index, 20))))
        }
    }

    function _copyChunk(bytes memory destination, address chunk, uint256 offset, uint256 length) private view {
        uint256 expectedSize = DATA_OFFSET + length;
        uint256 actualSize;
        assembly ("memory-safe") {
            actualSize := extcodesize(chunk)
        }
        if (actualSize != expectedSize) revert InvalidChunk(chunk, expectedSize, actualSize);

        assembly ("memory-safe") {
            extcodecopy(chunk, add(add(destination, 0x20), offset), DATA_OFFSET, length)
        }
    }

    function _copy(
        bytes memory source,
        uint256 sourceOffset,
        bytes memory destination,
        uint256 destinationOffset,
        uint256 length
    ) private pure {
        for (uint256 copied = 0; copied < length; copied += 32) {
            assembly ("memory-safe") {
                mstore(
                    add(add(destination, 0x20), add(destinationOffset, copied)),
                    mload(add(add(source, 0x20), add(sourceOffset, copied)))
                )
            }
        }
    }

    function _allocateWithCopySlack(uint256 length) private pure returns (bytes memory value) {
        value = new bytes(length + 32);
        assembly ("memory-safe") {
            mstore(value, length)
        }
    }

    function _min(uint256 left, uint256 right) private pure returns (uint256) {
        return left < right ? left : right;
    }
}
