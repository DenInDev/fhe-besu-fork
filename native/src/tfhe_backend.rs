use crate::backend::{
    require_nonempty_operands, require_operand_count, response, validate_uint32_request, FheBackend,
};
use crate::codec::{FheType, Operation, Request, Response, Status, MAX_CIPHERTEXT_BYTES};
use std::fs;
use std::sync::OnceLock;
use tfhe::prelude::*;
use tfhe::safe_serialization::{safe_deserialize, safe_serialize};
use tfhe::{set_server_key, CompressedFheBool, CompressedFheUint32, FheBool, FheUint32, ServerKey};

const SERVER_KEY_ENV: &str = "FHEBC_TFHE_SERVER_KEY_PATH";
const ALLOW_NONDETERMINISTIC_PBS_ENV: &str = "FHEBC_ALLOW_NONDETERMINISTIC_PBS";
const DEFAULT_SERVER_KEY_PATH: &str = "target/fhebc-keys/server.key";
const MAX_KEY_BYTES: u64 = 1 << 30;
const MAX_CIPHERTEXT_BYTES_U64: u64 = MAX_CIPHERTEXT_BYTES as u64;
const COMPRESSED_U32_MAGIC: &[u8; 8] = b"FBCU32C1";
const COMPRESSED_BOOL_MAGIC: &[u8; 8] = b"FBCBOLC1";

static SERVER_KEY: OnceLock<ServerKey> = OnceLock::new();

pub struct TfheRsBackend;

impl FheBackend for TfheRsBackend {
    fn execute(&self, request: &Request) -> Result<Response, Status> {
        validate_uint32_request(request)?;
        ensure_server_key_is_set()?;

        match request.operation {
            Operation::Add => {
                require_operand_count(request, 2)?;
                let compressed_output = prefers_compressed_output(request);
                let lhs = deserialize_u32(&request.operands[0])?;
                let rhs = deserialize_u32(&request.operands[1])?;
                serialize_u32(unchecked_add_u32(lhs, rhs)?, compressed_output)
                    .map(|result| response(FheType::Euint32, result))
            }
            Operation::Sub => {
                require_operand_count(request, 2)?;
                let compressed_output = prefers_compressed_output(request);
                if compressed_output && !allow_nondeterministic_pbs() {
                    return Err(Status::UnsupportedOperation);
                }
                let lhs = deserialize_u32(&request.operands[0])?;
                let rhs = deserialize_u32(&request.operands[1])?;
                let result = if compressed_output {
                    sub_u32(lhs, rhs)?
                } else {
                    unchecked_sub_u32(lhs, rhs)?
                };
                serialize_u32(result, compressed_output)
                    .map(|result| response(FheType::Euint32, result))
            }
            Operation::MulScalar => {
                require_operand_count(request, 2)?;
                let compressed_output = prefers_compressed_output(request);
                let lhs = deserialize_u32(&request.operands[0])?;
                let scalar = decode_scalar_u32(&request.operands[1])?;
                let result = scalar_mul_u32(lhs, scalar)?;
                serialize_u32(result, compressed_output)
                    .map(|result| response(FheType::Euint32, result))
            }
            Operation::Eq => {
                if !allow_nondeterministic_pbs() {
                    return Err(Status::UnsupportedOperation);
                }
                require_operand_count(request, 2)?;
                let compressed_output = prefers_compressed_output(request);
                let lhs = deserialize_u32(&request.operands[0])?;
                let rhs = deserialize_u32(&request.operands[1])?;
                serialize_bool(lhs.eq(&rhs), compressed_output)
                    .map(|result| response(FheType::Ebool, result))
            }
            Operation::Lt => {
                if !allow_nondeterministic_pbs() {
                    return Err(Status::UnsupportedOperation);
                }
                require_operand_count(request, 2)?;
                let compressed_output = prefers_compressed_output(request);
                let lhs = deserialize_u32(&request.operands[0])?;
                let rhs = deserialize_u32(&request.operands[1])?;
                serialize_bool(lhs.lt(&rhs), compressed_output)
                    .map(|result| response(FheType::Ebool, result))
            }
            Operation::Select => {
                if !allow_nondeterministic_pbs() {
                    return Err(Status::UnsupportedOperation);
                }
                require_operand_count(request, 3)?;
                let compressed_output = prefers_compressed_output(request);
                let condition = deserialize_bool(&request.operands[0])?;
                let when_true = deserialize_u32(&request.operands[1])?;
                let when_false = deserialize_u32(&request.operands[2])?;
                serialize_u32(
                    condition.if_then_else(&when_true, &when_false),
                    compressed_output,
                )
                .map(|result| response(FheType::Euint32, result))
            }
            Operation::Mean => {
                require_nonempty_operands(request)?;
                let compressed_output = prefers_compressed_output(request);
                let values = deserialize_u32_operands(&request.operands)?;
                serialize_u32(mean_u32(values)?, compressed_output)
                    .map(|result| response(FheType::Euint32, result))
            }
            Operation::Max => {
                require_nonempty_operands(request)?;
                let compressed_output = prefers_compressed_output(request);
                let values = deserialize_u32_operands(&request.operands)?;
                serialize_u32(max_u32(values)?, compressed_output)
                    .map(|result| response(FheType::Euint32, result))
            }
        }
    }
}

fn allow_nondeterministic_pbs() -> bool {
    std::env::var(ALLOW_NONDETERMINISTIC_PBS_ENV)
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

fn ensure_server_key_is_set() -> Result<(), Status> {
    let key = server_key()?;
    set_server_key(key.clone());
    Ok(())
}

fn server_key() -> Result<&'static ServerKey, Status> {
    if let Some(key) = SERVER_KEY.get() {
        return Ok(key);
    }

    let key = load_server_key()?;
    let _ = SERVER_KEY.set(key);
    SERVER_KEY.get().ok_or(Status::InternalError)
}

fn load_server_key() -> Result<ServerKey, Status> {
    let path =
        std::env::var(SERVER_KEY_ENV).unwrap_or_else(|_| DEFAULT_SERVER_KEY_PATH.to_string());
    let bytes = fs::read(path).map_err(|_| Status::InternalError)?;
    let key = safe_deserialize::<ServerKey>(bytes.as_slice(), MAX_KEY_BYTES)
        .map_err(|_| Status::InvalidCiphertext)?;
    Ok(force_deterministic_pbs(key))
}

fn force_deterministic_pbs(key: ServerKey) -> ServerKey {
    let (
        mut integer_key,
        cpk_key_switching_key_material,
        compression_key,
        decompression_key,
        noise_squashing_key,
        noise_squashing_compression_key,
        cpk_re_randomization_key,
        oprf_key,
        tag,
    ) = key.into_raw_parts();

    integer_key.set_deterministic_pbs_execution(true);

    ServerKey::from_raw_parts(
        integer_key,
        cpk_key_switching_key_material,
        compression_key,
        decompression_key,
        noise_squashing_key,
        noise_squashing_compression_key,
        cpk_re_randomization_key,
        oprf_key,
        tag,
    )
}

fn deserialize_u32(input: &[u8]) -> Result<FheUint32, Status> {
    if let Some(payload) = strip_magic(input, COMPRESSED_U32_MAGIC) {
        let compressed = safe_deserialize::<CompressedFheUint32>(payload, MAX_CIPHERTEXT_BYTES_U64)
            .map_err(|_| Status::InvalidCiphertext)?;
        return Ok(compressed.decompress());
    }
    safe_deserialize::<FheUint32>(input, MAX_CIPHERTEXT_BYTES_U64)
        .map_err(|_| Status::InvalidCiphertext)
}

fn deserialize_bool(input: &[u8]) -> Result<FheBool, Status> {
    if let Some(payload) = strip_magic(input, COMPRESSED_BOOL_MAGIC) {
        let compressed = safe_deserialize::<CompressedFheBool>(payload, MAX_CIPHERTEXT_BYTES_U64)
            .map_err(|_| Status::InvalidCiphertext)?;
        return Ok(compressed.decompress());
    }
    safe_deserialize::<FheBool>(input, MAX_CIPHERTEXT_BYTES_U64)
        .map_err(|_| Status::InvalidCiphertext)
}

fn deserialize_u32_operands(operands: &[Vec<u8>]) -> Result<Vec<FheUint32>, Status> {
    operands
        .iter()
        .map(|operand| deserialize_u32(operand))
        .collect()
}

fn unchecked_add_u32(lhs: FheUint32, rhs: FheUint32) -> Result<FheUint32, Status> {
    let key = server_key()?.clone();
    let (integer_key, _, _, _, _, _, _, _, _) = key.into_raw_parts();
    let (lhs_raw, id, tag, metadata) = lhs.into_raw_parts();
    let (rhs_raw, _, _, _) = rhs.into_raw_parts();
    let result = integer_key.unchecked_add(&lhs_raw, &rhs_raw);
    Ok(FheUint32::from_raw_parts(result, id, tag, metadata))
}

fn unchecked_sub_u32(lhs: FheUint32, rhs: FheUint32) -> Result<FheUint32, Status> {
    let key = server_key()?.clone();
    let (integer_key, _, _, _, _, _, _, _, _) = key.into_raw_parts();
    let (lhs_raw, id, tag, metadata) = lhs.into_raw_parts();
    let (rhs_raw, _, _, _) = rhs.into_raw_parts();
    let result = integer_key.unchecked_sub(&lhs_raw, &rhs_raw);
    Ok(FheUint32::from_raw_parts(result, id, tag, metadata))
}

fn decode_scalar_u32(input: &[u8]) -> Result<u32, Status> {
    if input.len() != 8 {
        return Err(Status::InvalidEncoding);
    }
    let value = u64::from_be_bytes(input.try_into().map_err(|_| Status::InvalidEncoding)?);
    u32::try_from(value).map_err(|_| Status::InputTooLarge)
}

fn scalar_mul_u32(lhs: FheUint32, scalar: u32) -> Result<FheUint32, Status> {
    if scalar == 0 {
        return Err(Status::UnsupportedOperation);
    }
    if scalar > 1024 {
        return Err(Status::InputTooLarge);
    }
    if scalar == 1 {
        return Ok(lhs);
    }

    let mut acc = lhs.clone();
    for _ in 1..scalar {
        acc = unchecked_add_u32(acc, lhs.clone())?;
    }
    Ok(acc)
}

fn mean_u32(values: Vec<FheUint32>) -> Result<FheUint32, Status> {
    let divisor = values.len();
    if divisor == 0 {
        return Err(Status::InvalidEncoding);
    }

    let key = server_key()?.clone();
    let (integer_key, _, _, _, _, _, _, _, _) = key.into_raw_parts();
    let mut iter = values.into_iter();
    let first = iter.next().ok_or(Status::InvalidEncoding)?;
    let (mut acc_raw, id, tag, metadata) = first.into_raw_parts();
    integer_key.full_propagate_parallelized(&mut acc_raw);

    for value in iter {
        let (mut value_raw, _, _, _) = value.into_raw_parts();
        integer_key.full_propagate_parallelized(&mut value_raw);
        acc_raw = integer_key.unchecked_add(&acc_raw, &value_raw);
        integer_key.full_propagate_parallelized(&mut acc_raw);
    }

    let result_raw = if divisor == 1 {
        acc_raw
    } else if divisor.is_power_of_two() {
        integer_key.unchecked_scalar_right_shift_parallelized(
            &acc_raw,
            divisor.trailing_zeros() as u64,
        )
    } else {
        integer_key.unchecked_scalar_div_parallelized(&acc_raw, divisor as u64)
    };

    Ok(FheUint32::from_raw_parts(result_raw, id, tag, metadata))
}

fn max_u32(values: Vec<FheUint32>) -> Result<FheUint32, Status> {
    let key = server_key()?.clone();
    let (integer_key, _, _, _, _, _, _, _, _) = key.into_raw_parts();
    let mut iter = values.into_iter();
    let first = iter.next().ok_or(Status::InvalidEncoding)?;
    let (mut max_raw, id, tag, metadata) = first.into_raw_parts();
    integer_key.full_propagate_parallelized(&mut max_raw);

    for value in iter {
        let (mut value_raw, _, _, _) = value.into_raw_parts();
        integer_key.full_propagate_parallelized(&mut value_raw);
        max_raw = integer_key.unchecked_max_parallelized(&max_raw, &value_raw);
        integer_key.full_propagate_parallelized(&mut max_raw);
    }

    Ok(FheUint32::from_raw_parts(max_raw, id, tag, metadata))
}

fn sub_u32(lhs: FheUint32, rhs: FheUint32) -> Result<FheUint32, Status> {
    Ok(&lhs - &rhs)
}

fn serialize_u32(ciphertext: FheUint32, compressed: bool) -> Result<Vec<u8>, Status> {
    let mut out = Vec::new();
    if compressed {
        let compressed = ciphertext.compress();
        safe_serialize(&compressed, &mut out, MAX_CIPHERTEXT_BYTES_U64)
            .map_err(|_| Status::InternalError)?;
        Ok(wrap_magic(COMPRESSED_U32_MAGIC, out))
    } else {
        safe_serialize(&ciphertext, &mut out, MAX_CIPHERTEXT_BYTES_U64)
            .map_err(|_| Status::InternalError)?;
        Ok(out)
    }
}

fn serialize_bool(ciphertext: FheBool, compressed: bool) -> Result<Vec<u8>, Status> {
    let mut out = Vec::new();
    if compressed {
        let compressed = ciphertext.compress();
        safe_serialize(&compressed, &mut out, MAX_CIPHERTEXT_BYTES_U64)
            .map_err(|_| Status::InternalError)?;
        Ok(wrap_magic(COMPRESSED_BOOL_MAGIC, out))
    } else {
        safe_serialize(&ciphertext, &mut out, MAX_CIPHERTEXT_BYTES_U64)
            .map_err(|_| Status::InternalError)?;
        Ok(out)
    }
}

fn prefers_compressed_output(request: &Request) -> bool {
    request.operands.iter().any(|operand| {
        strip_magic(operand, COMPRESSED_U32_MAGIC).is_some()
            || strip_magic(operand, COMPRESSED_BOOL_MAGIC).is_some()
    })
}

fn strip_magic<'a>(input: &'a [u8], magic: &[u8; 8]) -> Option<&'a [u8]> {
    input.strip_prefix(magic)
}

fn wrap_magic(magic: &[u8; 8], payload: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(magic.len() + payload.len());
    out.extend_from_slice(magic);
    out.extend_from_slice(&payload);
    out
}
