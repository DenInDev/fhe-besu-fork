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

public final class FheConstants {
  public static final String PRECOMPILE_ADDRESS =
      "0x0000000000000000000000000000000000000100";
  public static final String ZK_VERIFY_PRECOMPILE_ADDRESS =
      "0x00000000000000000000000000000000000000ff";

  public static final int VERSION = 1;
  public static final int VERSION_STORED = 2;

  public static final int STATUS_OK = 0x00;
  public static final int STATUS_INVALID_ENCODING = 0x01;
  public static final int STATUS_INVALID_CIPHERTEXT = 0x02;
  public static final int STATUS_PARAMETER_SET_MISMATCH = 0x03;
  public static final int STATUS_UNSUPPORTED_OPERATION = 0x04;
  public static final int STATUS_INPUT_TOO_LARGE = 0x05;
  public static final int STATUS_INTERNAL_ERROR = 0x06;

  public static final int OP_ADD = 0x01;
  public static final int OP_SUB = 0x02;
  public static final int OP_MUL_SCALAR = 0x03;
  public static final int OP_EQ = 0x04;
  public static final int OP_LT = 0x05;
  public static final int OP_SELECT = 0x06;
  public static final int OP_MEAN = 0x07;
  public static final int OP_MAX = 0x08;

  public static final int TYPE_EBOOL = 0x01;
  public static final int TYPE_EUINT8 = 0x02;
  public static final int TYPE_EUINT16 = 0x03;
  public static final int TYPE_EUINT32 = 0x04;

  public static final int PARAM_TFHE_UINT32_V1 = 0x0001;

  public static final int MAX_OPERAND_COUNT = 64;
  public static final int MAX_CIPHERTEXT_BYTES = 16 * 1024 * 1024;
  public static final int MAX_REQUEST_BYTES = 128 * 1024 * 1024;
  public static final int STORED_REF_BYTES = 58;

  private FheConstants() {}
}
