mod backend;
mod codec;
mod tfhe_backend;

use crate::backend::FheBackend;
use crate::codec::{decode_request, encode_error, encode_success, Operation, Status};
use jni::objects::{JByteArray, JClass};
use jni::sys::jbyteArray;
use jni::JNIEnv;
use std::panic::catch_unwind;
use std::thread;

const DISPATCH_STACK_BYTES_ENV: &str = "FHEBC_NATIVE_DISPATCH_STACK_BYTES";
const DEFAULT_DISPATCH_STACK_BYTES: usize = 64 * 1024 * 1024;

#[no_mangle]
pub extern "system" fn Java_it_fhebc_besu_precompile_TfheNative_dispatch(
    env: JNIEnv,
    _class: JClass,
    input: JByteArray,
) -> jbyteArray {
    dispatch_jni(env, input)
}

#[no_mangle]
pub extern "system" fn Java_org_hyperledger_besu_evm_precompile_TfheNative_dispatch(
    env: JNIEnv,
    _class: JClass,
    input: JByteArray,
) -> jbyteArray {
    dispatch_jni(env, input)
}

fn dispatch_jni(env: JNIEnv, input: JByteArray) -> jbyteArray {
    let input = match env.convert_byte_array(&input) {
        Ok(input) => input,
        Err(_) => return jni_response(env, encode_error(Status::InvalidEncoding)),
    };
    let response = run_dispatch_worker(input);
    jni_response(env, response)
}

fn jni_response(env: JNIEnv, response: Vec<u8>) -> jbyteArray {
    match env.byte_array_from_slice(&response) {
        Ok(output) => output.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

fn run_dispatch_worker(input: Vec<u8>) -> Vec<u8> {
    let stack_size = std::env::var(DISPATCH_STACK_BYTES_ENV)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value >= 1024 * 1024)
        .unwrap_or(DEFAULT_DISPATCH_STACK_BYTES);

    let worker = thread::Builder::new()
        .name("fhebc-native-dispatch".to_string())
        .stack_size(stack_size)
        .spawn(move || {
            catch_unwind(|| dispatch_canonical(&input))
                .unwrap_or_else(|_| encode_error(Status::InternalError))
        });

    match worker {
        Ok(handle) => handle
            .join()
            .unwrap_or_else(|_| encode_error(Status::InternalError)),
        Err(_) => encode_error(Status::InternalError),
    }
}

pub fn dispatch_canonical(input: &[u8]) -> Vec<u8> {
    match dispatch_result(input) {
        Ok(response) => encode_success(response),
        Err(status) => encode_error(status),
    }
}

fn dispatch_result(input: &[u8]) -> Result<codec::Response, Status> {
    let request = decode_request(input)?;
    validate_operation_shape(&request)?;
    selected_backend().execute(&request)
}

fn selected_backend() -> Box<dyn FheBackend> {
    Box::new(tfhe_backend::TfheRsBackend)
}

fn validate_operation_shape(request: &codec::Request) -> Result<(), Status> {
    match request.operation {
        Operation::Add | Operation::Sub | Operation::Eq | Operation::Lt => {
            require_operand_count(request, 2)
        }
        Operation::MulScalar => require_operand_count(request, 2),
        Operation::Select => require_operand_count(request, 3),
        Operation::Mean | Operation::Max => {
            if request.operands.is_empty() {
                Err(Status::InvalidEncoding)
            } else {
                Ok(())
            }
        }
    }
}

fn require_operand_count(request: &codec::Request, expected: usize) -> Result<(), Status> {
    if request.operands.len() == expected {
        Ok(())
    } else {
        Err(Status::InvalidEncoding)
    }
}
