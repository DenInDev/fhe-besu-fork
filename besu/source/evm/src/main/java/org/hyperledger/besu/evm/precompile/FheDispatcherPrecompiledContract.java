/*
 * Copyright Hyperledger Besu Contributors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on
 * an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
package org.hyperledger.besu.evm.precompile;

import org.hyperledger.besu.datatypes.Address;
import org.hyperledger.besu.datatypes.Hash;
import org.hyperledger.besu.datatypes.Wei;
import org.hyperledger.besu.evm.account.Account;
import org.hyperledger.besu.evm.account.MutableAccount;
import org.hyperledger.besu.evm.frame.MessageFrame;
import org.hyperledger.besu.evm.gascalculator.GasCalculator;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import javax.annotation.Nonnull;

import org.apache.tuweni.bytes.Bytes;
import org.apache.tuweni.bytes.Bytes32;

/** Native TFHE-rs dispatcher precompile for local FHEBC Besu experiments. */
public final class FheDispatcherPrecompiledContract extends AbstractPrecompiledContract {
  private static final int DATA_BLOB_PREFIX = 0x00;
  private static final int MAX_CHUNK_BYTES = 24_575;

  public FheDispatcherPrecompiledContract(final GasCalculator gasCalculator) {
    super("FHEBC_TFHE_DISPATCHER", gasCalculator);
  }

  @Override
  public long gasRequirement(final Bytes input) {
    try {
      if (input.size() > 0 && (input.get(0) & 0xff) == FheConstants.VERSION_STORED) {
        return storedGasRequirement(input);
      }
      final FheRequest request = FheCodec.decodeRequest(input.toArrayUnsafe());
      return switch (request.operation()) {
        case FheConstants.OP_ADD -> 500_000L;
        case FheConstants.OP_SUB -> 4_000_000L;
        case FheConstants.OP_MUL_SCALAR -> 750_000L;
        case FheConstants.OP_EQ -> 12_000_000L;
        case FheConstants.OP_LT -> 18_000_000L;
        case FheConstants.OP_SELECT -> 12_000_000L;
        case FheConstants.OP_MEAN -> 6_000_000L + 2_000_000L * request.operands().size();
        case FheConstants.OP_MAX -> 14_000_000L + 4_000_000L * request.operands().size();
        default -> 1_000_000L;
      };
    } catch (RuntimeException ignored) {
      return 1_000_000L;
    }
  }

  @Nonnull
  @Override
  public PrecompileContractResult computePrecompile(
      final Bytes input, @Nonnull final MessageFrame messageFrame) {
    try {
      final byte[] canonicalRequest = input.toArrayUnsafe();
      if (canonicalRequest.length > 0
          && (canonicalRequest[0] & 0xff) == FheConstants.VERSION_STORED) {
        return PrecompileContractResult.success(Bytes.wrap(computeStored(canonicalRequest, messageFrame)));
      }
      final FheRequest request = FheCodec.decodeRequest(canonicalRequest);
      validateRequest(request);
      return PrecompileContractResult.success(Bytes.wrap(TfheNative.dispatch(canonicalRequest)));
    } catch (final FhePrecompileException exception) {
      return PrecompileContractResult.success(Bytes.wrap(FheCodec.encodeError(exception.status())));
    } catch (final Throwable throwable) {
      return PrecompileContractResult.success(
          Bytes.wrap(FheCodec.encodeError(FheConstants.STATUS_INTERNAL_ERROR)));
    }
  }

  private static void validateRequest(final FheRequest request) {
    if (request.parameterSet() != FheConstants.PARAM_TFHE_UINT32_V1) {
      throw new FhePrecompileException(FheConstants.STATUS_PARAMETER_SET_MISMATCH);
    }
    if (request.inputType() != FheConstants.TYPE_EUINT32) {
      throw new FhePrecompileException(FheConstants.STATUS_UNSUPPORTED_OPERATION);
    }

    final int operandCount = request.operands().size();
    switch (request.operation()) {
      case FheConstants.OP_ADD,
          FheConstants.OP_SUB,
          FheConstants.OP_EQ,
          FheConstants.OP_LT -> requireOperandCount(operandCount, 2);
      case FheConstants.OP_MUL_SCALAR -> requireOperandCount(operandCount, 2);
      case FheConstants.OP_SELECT -> requireOperandCount(operandCount, 3);
      case FheConstants.OP_MEAN, FheConstants.OP_MAX -> {
        if (operandCount == 0) {
          throw new FhePrecompileException(FheConstants.STATUS_INVALID_ENCODING);
        }
      }
      default -> throw new FhePrecompileException(FheConstants.STATUS_UNSUPPORTED_OPERATION);
    }
  }

  private static void requireOperandCount(final int actual, final int expected) {
    if (actual != expected) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_ENCODING);
    }
  }

  private long storedGasRequirement(final Bytes input) {
    final StoredRequest request = decodeStoredRequest(input.toArrayUnsafe());
    validateStoredRequest(request);

    final int outputLength =
        request.refs().stream().mapToInt(StoredBlobRef::length).max().orElse(0);
    final long outputByteDepositGas =
        gasCalculator().codeDepositGasCost(equivalentBlobCodeSize(outputLength));
    final long referenceReadGas = 500_000L * request.refs().size();
    final long stateBookkeepingGas = 500_000L;
    final long nativeComputeGas =
        switch (request.operation()) {
          case FheConstants.OP_ADD -> 2_000_000L;
          case FheConstants.OP_MUL_SCALAR -> 2_250_000L;
          default -> 8_000_000L;
        };
    return nativeComputeGas + referenceReadGas + stateBookkeepingGas + outputByteDepositGas;
  }

  private static int equivalentBlobCodeSize(final int payloadLength) {
    if (payloadLength <= 0) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_CIPHERTEXT);
    }
    final int chunkCount = (payloadLength + MAX_CHUNK_BYTES - 1) / MAX_CHUNK_BYTES;
    final int chunkCodeBytes = payloadLength + chunkCount;
    if (chunkCount == 1) {
      return chunkCodeBytes;
    }
    return chunkCodeBytes + 1 + chunkCount * Address.SIZE;
  }

  private static byte[] computeStored(final byte[] input, final MessageFrame messageFrame) {
    if (messageFrame.isStatic()) {
      throw new FhePrecompileException(FheConstants.STATUS_UNSUPPORTED_OPERATION);
    }

    final StoredRequest request = decodeStoredRequest(input);
    validateStoredRequest(request);

    final List<byte[]> operands = new ArrayList<>(request.refs().size() + 1);
    for (final StoredBlobRef ref : request.refs()) {
      operands.add(readBlob(ref, messageFrame));
    }
    if (request.operation() == FheConstants.OP_MUL_SCALAR) {
      operands.add(request.extra());
    }

    final byte[] canonicalRequest =
        encodeCanonicalRequest(
            request.operation(), request.inputType(), request.parameterSet(), operands);
    final byte[] nativeResponse = TfheNative.dispatch(canonicalRequest);
    final byte[] ciphertext =
        decodeNativeCiphertextResponse(nativeResponse, FheConstants.TYPE_EUINT32, request.parameterSet());
    final StoredBlobRef stored = writeBlob(ciphertext, messageFrame);
    return FheCodec.encodeOk(
        FheConstants.TYPE_EUINT32, request.parameterSet(), encodeStoredBlobPayload(stored));
  }

  private static StoredRequest decodeStoredRequest(final byte[] input) {
    if (input.length < 6 || input.length > FheConstants.MAX_REQUEST_BYTES) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_ENCODING);
    }
    if (u8(input, 0) != FheConstants.VERSION_STORED) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_ENCODING);
    }

    final int operation = u8(input, 1);
    final int inputType = u8(input, 2);
    final int parameterSet = u16(input, 3);
    final int refCount = u8(input, 5);
    if (refCount > FheConstants.MAX_OPERAND_COUNT) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_ENCODING);
    }

    int offset = 6;
    final List<StoredBlobRef> refs = new ArrayList<>(refCount);
    for (int i = 0; i < refCount; i++) {
      require(input, offset, FheConstants.STORED_REF_BYTES);
      final Address manifest = Address.wrap(Bytes.wrap(input, offset, Address.SIZE));
      offset += Address.SIZE;
      final int length = (int) u32(input, offset);
      offset += 4;
      final int chunkCount = u16(input, offset);
      offset += 2;
      final Hash contentHash = Hash.wrap(Bytes32.wrap(Bytes.wrap(input, offset, Bytes32.SIZE)));
      offset += Bytes32.SIZE;
      refs.add(new StoredBlobRef(manifest, length, chunkCount, contentHash));
    }

    final byte[] extra;
    if (operation == FheConstants.OP_MUL_SCALAR) {
      require(input, offset, Long.BYTES);
      extra = new byte[Long.BYTES];
      System.arraycopy(input, offset, extra, 0, Long.BYTES);
      offset += Long.BYTES;
    } else {
      extra = new byte[0];
    }

    if (offset != input.length) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_ENCODING);
    }
    return new StoredRequest(operation, inputType, parameterSet, List.copyOf(refs), extra);
  }

  private static void validateStoredRequest(final StoredRequest request) {
    if (request.parameterSet() != FheConstants.PARAM_TFHE_UINT32_V1) {
      throw new FhePrecompileException(FheConstants.STATUS_PARAMETER_SET_MISMATCH);
    }
    if (request.inputType() != FheConstants.TYPE_EUINT32) {
      throw new FhePrecompileException(FheConstants.STATUS_UNSUPPORTED_OPERATION);
    }
    switch (request.operation()) {
      case FheConstants.OP_ADD -> requireOperandCount(request.refs().size(), 2);
      case FheConstants.OP_MUL_SCALAR -> requireOperandCount(request.refs().size(), 1);
      default -> throw new FhePrecompileException(FheConstants.STATUS_UNSUPPORTED_OPERATION);
    }
  }

  private static byte[] readBlob(final StoredBlobRef ref, final MessageFrame messageFrame) {
    if (ref.length() <= 0 || ref.chunkCount() <= 0) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_ENCODING);
    }
    final byte[] data;
    if (ref.chunkCount() == 1) {
      data = readDataAccount(ref.manifest(), ref.length(), messageFrame);
    } else {
      final byte[] manifestData =
          readDataAccount(ref.manifest(), ref.chunkCount() * Address.SIZE, messageFrame);
      final ByteArrayOutputStream out = new ByteArrayOutputStream(ref.length());
      int written = 0;
      for (int i = 0; i < ref.chunkCount(); i++) {
        final Address chunk = Address.wrap(Bytes.wrap(manifestData, i * Address.SIZE, Address.SIZE));
        final int chunkLength = Math.min(MAX_CHUNK_BYTES, ref.length() - written);
        out.writeBytes(readDataAccount(chunk, chunkLength, messageFrame));
        written += chunkLength;
      }
      data = out.toByteArray();
    }
    if (!Hash.hash(Bytes.wrap(data)).equals(ref.contentHash())) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_CIPHERTEXT);
    }
    return data;
  }

  private static byte[] readDataAccount(
      final Address address, final int expectedLength, final MessageFrame messageFrame) {
    final Account account = messageFrame.getWorldUpdater().get(address);
    if (account == null) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_CIPHERTEXT);
    }
    final Bytes code = account.getCode();
    if (code.size() != expectedLength + 1 || (code.get(0) & 0xff) != DATA_BLOB_PREFIX) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_CIPHERTEXT);
    }
    return code.slice(1, expectedLength).toArray();
  }

  private static StoredBlobRef writeBlob(final byte[] data, final MessageFrame messageFrame) {
    if (data.length == 0) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_CIPHERTEXT);
    }

    final Hash contentHash = Hash.hash(Bytes.wrap(data));
    final int chunkCount = (data.length + MAX_CHUNK_BYTES - 1) / MAX_CHUNK_BYTES;
    final List<Address> chunks = new ArrayList<>(chunkCount);
    int offset = 0;
    for (int i = 0; i < chunkCount; i++) {
      final int chunkLength = Math.min(MAX_CHUNK_BYTES, data.length - offset);
      final byte[] chunkCode = new byte[chunkLength + 1];
      chunkCode[0] = 0;
      System.arraycopy(data, offset, chunkCode, 1, chunkLength);
      final Address chunkAddress = blobAddress(contentHash, i, false);
      putCodeIfAbsent(chunkAddress, Bytes.wrap(chunkCode), messageFrame);
      chunks.add(chunkAddress);
      offset += chunkLength;
    }

    if (chunkCount == 1) {
      return new StoredBlobRef(chunks.get(0), data.length, chunkCount, contentHash);
    }

    final byte[] manifestData = new byte[chunkCount * Address.SIZE + 1];
    manifestData[0] = 0;
    for (int i = 0; i < chunkCount; i++) {
      System.arraycopy(chunks.get(i).toArrayUnsafe(), 0, manifestData, 1 + i * Address.SIZE, Address.SIZE);
    }
    final Address manifestAddress = blobAddress(contentHash, 0, true);
    putCodeIfAbsent(manifestAddress, Bytes.wrap(manifestData), messageFrame);
    return new StoredBlobRef(manifestAddress, data.length, chunkCount, contentHash);
  }

  private static void putCodeIfAbsent(
      final Address address, final Bytes code, final MessageFrame messageFrame) {
    final MutableAccount account = messageFrame.getWorldUpdater().getOrCreate(address);
    final Bytes existing = account.getCode();
    if (!existing.isEmpty() && !existing.equals(code)) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_CIPHERTEXT);
    }
    if (existing.isEmpty()) {
      account.setNonce(1L);
      account.setBalance(Wei.ZERO);
      account.setCode(code);
    }
  }

  private static Address blobAddress(final Hash contentHash, final int index, final boolean manifest) {
    final byte[] seed = new byte[8 + Bytes32.SIZE + 4 + 1];
    final byte[] prefix = new byte[] {'F', 'H', 'E', 'B', 'C', 'B', 'L', 'B'};
    System.arraycopy(prefix, 0, seed, 0, prefix.length);
    System.arraycopy(contentHash.toArrayUnsafe(), 0, seed, prefix.length, Bytes32.SIZE);
    final int offset = prefix.length + Bytes32.SIZE;
    seed[offset] = (byte) ((index >>> 24) & 0xff);
    seed[offset + 1] = (byte) ((index >>> 16) & 0xff);
    seed[offset + 2] = (byte) ((index >>> 8) & 0xff);
    seed[offset + 3] = (byte) (index & 0xff);
    seed[offset + 4] = (byte) (manifest ? 1 : 0);
    return Address.extract(Hash.hash(Bytes.wrap(seed)));
  }

  private static byte[] encodeCanonicalRequest(
      final int operation, final int inputType, final int parameterSet, final List<byte[]> operands) {
    final ByteArrayOutputStream out = new ByteArrayOutputStream();
    out.write(FheConstants.VERSION);
    out.write(operation & 0xff);
    out.write(inputType & 0xff);
    writeU16(out, parameterSet);
    out.write(operands.size() & 0xff);
    for (final byte[] operand : operands) {
      writeU32(out, operand.length);
      out.writeBytes(operand);
    }
    return out.toByteArray();
  }

  private static byte[] decodeNativeCiphertextResponse(
      final byte[] response, final int expectedType, final int expectedParameterSet) {
    require(response, 0, 8);
    final int status = u8(response, 0);
    if (status != FheConstants.STATUS_OK) {
      throw new FhePrecompileException(status);
    }
    if (u8(response, 1) != expectedType || u16(response, 2) != expectedParameterSet) {
      throw new FhePrecompileException(FheConstants.STATUS_PARAMETER_SET_MISMATCH);
    }
    final long length = u32(response, 4);
    if (length > FheConstants.MAX_CIPHERTEXT_BYTES || response.length != 8 + (int) length) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_ENCODING);
    }
    final byte[] ciphertext = new byte[(int) length];
    System.arraycopy(response, 8, ciphertext, 0, ciphertext.length);
    return ciphertext;
  }

  private static byte[] encodeStoredBlobPayload(final StoredBlobRef ref) {
    final byte[] payload = new byte[128];
    System.arraycopy(ref.manifest().toArrayUnsafe(), 0, payload, 12, Address.SIZE);
    writeU32(payload, 32 + 28, ref.length());
    writeU16(payload, 64 + 30, ref.chunkCount());
    System.arraycopy(ref.contentHash().toArrayUnsafe(), 0, payload, 96, Bytes32.SIZE);
    return payload;
  }

  private static void require(final byte[] input, final int offset, final int length) {
    if (offset < 0 || length < 0 || offset + length > input.length) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_ENCODING);
    }
  }

  private static int u8(final byte[] input, final int offset) {
    return input[offset] & 0xff;
  }

  private static int u16(final byte[] input, final int offset) {
    return ((input[offset] & 0xff) << 8) | (input[offset + 1] & 0xff);
  }

  private static long u32(final byte[] input, final int offset) {
    return ((long) (input[offset] & 0xff) << 24)
        | ((long) (input[offset + 1] & 0xff) << 16)
        | ((long) (input[offset + 2] & 0xff) << 8)
        | (long) (input[offset + 3] & 0xff);
  }

  private static void writeU16(final ByteArrayOutputStream out, final int value) {
    out.write((value >>> 8) & 0xff);
    out.write(value & 0xff);
  }

  private static void writeU32(final ByteArrayOutputStream out, final int value) {
    out.write((value >>> 24) & 0xff);
    out.write((value >>> 16) & 0xff);
    out.write((value >>> 8) & 0xff);
    out.write(value & 0xff);
  }

  private static void writeU16(final byte[] out, final int offset, final int value) {
    out[offset] = (byte) ((value >>> 8) & 0xff);
    out[offset + 1] = (byte) (value & 0xff);
  }

  private static void writeU32(final byte[] out, final int offset, final int value) {
    out[offset] = (byte) ((value >>> 24) & 0xff);
    out[offset + 1] = (byte) ((value >>> 16) & 0xff);
    out[offset + 2] = (byte) ((value >>> 8) & 0xff);
    out[offset + 3] = (byte) (value & 0xff);
  }

  private static final class StoredBlobRef {
    private final Address manifest;
    private final int length;
    private final int chunkCount;
    private final Hash contentHash;

    private StoredBlobRef(
        final Address manifest, final int length, final int chunkCount, final Hash contentHash) {
      this.manifest = manifest;
      this.length = length;
      this.chunkCount = chunkCount;
      this.contentHash = contentHash;
    }

    private Address manifest() {
      return manifest;
    }

    private int length() {
      return length;
    }

    private int chunkCount() {
      return chunkCount;
    }

    private Hash contentHash() {
      return contentHash;
    }
  }

  private static final class StoredRequest {
    private final int operation;
    private final int inputType;
    private final int parameterSet;
    private final List<StoredBlobRef> refs;
    private final byte[] extra;

    private StoredRequest(
        final int operation,
        final int inputType,
        final int parameterSet,
        final List<StoredBlobRef> refs,
        final byte[] extra) {
      this.operation = operation;
      this.inputType = inputType;
      this.parameterSet = parameterSet;
      this.refs = refs;
      this.extra = extra;
    }

    private int operation() {
      return operation;
    }

    private int inputType() {
      return inputType;
    }

    private int parameterSet() {
      return parameterSet;
    }

    private List<StoredBlobRef> refs() {
      return refs;
    }

    private byte[] extra() {
      return extra;
    }
  }
}
