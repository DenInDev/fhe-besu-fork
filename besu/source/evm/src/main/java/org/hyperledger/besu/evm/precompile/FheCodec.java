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

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;

public final class FheCodec {
  private FheCodec() {}

  public static FheRequest decodeRequest(final byte[] input) {
    if (input.length < 6 || input.length > FheConstants.MAX_REQUEST_BYTES) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_ENCODING);
    }

    final int version = u8(input, 0);
    final int operation = u8(input, 1);
    final int inputType = u8(input, 2);
    final int parameterSet = u16(input, 3);
    final int operandCount = u8(input, 5);

    if (version != FheConstants.VERSION || operandCount > FheConstants.MAX_OPERAND_COUNT) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_ENCODING);
    }

    int offset = 6;
    final List<byte[]> operands = new ArrayList<>(operandCount);
    for (int i = 0; i < operandCount; i++) {
      require(input, offset, 4);
      final long operandLength = u32(input, offset);
      offset += 4;
      if (operandLength > FheConstants.MAX_CIPHERTEXT_BYTES) {
        throw new FhePrecompileException(FheConstants.STATUS_INPUT_TOO_LARGE);
      }
      require(input, offset, (int) operandLength);
      final byte[] operand = new byte[(int) operandLength];
      System.arraycopy(input, offset, operand, 0, (int) operandLength);
      operands.add(operand);
      offset += (int) operandLength;
    }

    if (offset != input.length) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_ENCODING);
    }

    return new FheRequest(version, operation, inputType, parameterSet, List.copyOf(operands));
  }

  public static byte[] encodeError(final int status) {
    final ByteArrayOutputStream out = new ByteArrayOutputStream(8);
    out.write(status & 0xff);
    out.write(0);
    writeU16(out, 0);
    writeU32(out, 0);
    return out.toByteArray();
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
}
