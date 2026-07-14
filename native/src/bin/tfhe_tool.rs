fn main() {
    if let Err(error) = real_main() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn real_main() -> Result<(), Box<dyn std::error::Error>> {
    use std::env;
    use std::fs;
    use std::path::Path;
    use tfhe::prelude::*;
    use tfhe::safe_serialization::{safe_deserialize, safe_serialize};
    use tfhe::shortint::parameters::COMP_PARAM_MESSAGE_2_CARRY_2_KS_PBS_TUNIFORM_2M128;
    use tfhe::{
        generate_keys, set_server_key, ClientKey, CompressedCiphertextList,
        CompressedCiphertextListBuilder, CompressedFheBool, CompressedFheUint32, ConfigBuilder,
        FheBool, FheUint32, ServerKey,
    };

    const MAX_KEY_BYTES: u64 = 1 << 30;
    const MAX_CIPHERTEXT_BYTES: u64 = 16 * 1024 * 1024;
    const COMPRESSED_U32_MAGIC: &[u8; 8] = b"FBCU32C1";
    const COMPRESSED_BOOL_MAGIC: &[u8; 8] = b"FBCBOLC1";
    const PACKED_U32_MAGIC: &[u8; 8] = b"FBCU32P1";
    const PACKED_BOOL_MAGIC: &[u8; 8] = b"FBCBOLP1";

    fn read_client_key(path: &str) -> Result<ClientKey, Box<dyn std::error::Error>> {
        let data = fs::read(path)?;
        Ok(safe_deserialize::<ClientKey>(
            data.as_slice(),
            MAX_KEY_BYTES,
        )?)
    }

    fn read_server_key(path: &str) -> Result<ServerKey, Box<dyn std::error::Error>> {
        let data = fs::read(path)?;
        let server_key = safe_deserialize::<ServerKey>(data.as_slice(), MAX_KEY_BYTES)?;
        Ok(force_deterministic_pbs(server_key))
    }

    fn write_bytes(path: &str, bytes: Vec<u8>) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(parent) = Path::new(path).parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, bytes)?;
        Ok(())
    }

    fn write_client_key(value: &ClientKey, path: &str) -> Result<(), Box<dyn std::error::Error>> {
        let mut out = Vec::new();
        safe_serialize(value, &mut out, MAX_KEY_BYTES)?;
        write_bytes(path, out)
    }

    fn write_server_key(value: &ServerKey, path: &str) -> Result<(), Box<dyn std::error::Error>> {
        let mut out = Vec::new();
        safe_serialize(value, &mut out, MAX_KEY_BYTES)?;
        write_bytes(path, out)
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

    fn write_u32_ciphertext(
        value: &FheUint32,
        path: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut out = Vec::new();
        safe_serialize(value, &mut out, MAX_CIPHERTEXT_BYTES)?;
        write_bytes(path, out)
    }

    fn write_compressed_u32_ciphertext(
        value: &CompressedFheUint32,
        path: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut out = Vec::new();
        safe_serialize(value, &mut out, MAX_CIPHERTEXT_BYTES)?;
        write_bytes(path, wrap_magic(COMPRESSED_U32_MAGIC, out))
    }

    fn write_bool_ciphertext(
        value: &FheBool,
        path: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut out = Vec::new();
        safe_serialize(value, &mut out, MAX_CIPHERTEXT_BYTES)?;
        write_bytes(path, out)
    }

    fn write_compressed_bool_ciphertext(
        value: &CompressedFheBool,
        path: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut out = Vec::new();
        safe_serialize(value, &mut out, MAX_CIPHERTEXT_BYTES)?;
        write_bytes(path, wrap_magic(COMPRESSED_BOOL_MAGIC, out))
    }

    fn ensure_optional_server_key() -> Result<(), Box<dyn std::error::Error>> {
        if let Ok(path) = env::var("FHEBC_TFHE_SERVER_KEY_PATH") {
            let server_key = read_server_key(&path)?;
            set_server_key(server_key);
        }
        Ok(())
    }

    fn read_u32_ciphertext(path: &str) -> Result<FheUint32, Box<dyn std::error::Error>> {
        let data = fs::read(path)?;
        if let Some(payload) = strip_magic(&data, PACKED_U32_MAGIC) {
            ensure_optional_server_key()?;
            let compressed =
                safe_deserialize::<CompressedCiphertextList>(payload, MAX_CIPHERTEXT_BYTES)?;
            return compressed
                .get::<FheUint32>(0)?
                .ok_or_else(|| "packed ciphertext list does not contain an FheUint32".into());
        }
        if let Some(payload) = strip_magic(&data, COMPRESSED_U32_MAGIC) {
            ensure_optional_server_key()?;
            let compressed =
                safe_deserialize::<CompressedFheUint32>(payload, MAX_CIPHERTEXT_BYTES)?;
            return Ok(compressed.decompress());
        }
        Ok(safe_deserialize::<FheUint32>(
            data.as_slice(),
            MAX_CIPHERTEXT_BYTES,
        )?)
    }

    fn read_bool_ciphertext(path: &str) -> Result<FheBool, Box<dyn std::error::Error>> {
        let data = fs::read(path)?;
        if let Some(payload) = strip_magic(&data, PACKED_BOOL_MAGIC) {
            ensure_optional_server_key()?;
            let compressed =
                safe_deserialize::<CompressedCiphertextList>(payload, MAX_CIPHERTEXT_BYTES)?;
            return compressed
                .get::<FheBool>(0)?
                .ok_or_else(|| "packed ciphertext list does not contain an FheBool".into());
        }
        if let Some(payload) = strip_magic(&data, COMPRESSED_BOOL_MAGIC) {
            ensure_optional_server_key()?;
            let compressed = safe_deserialize::<CompressedFheBool>(payload, MAX_CIPHERTEXT_BYTES)?;
            return Ok(compressed.decompress());
        }
        Ok(safe_deserialize::<FheBool>(
            data.as_slice(),
            MAX_CIPHERTEXT_BYTES,
        )?)
    }

    let args = env::args().collect::<Vec<_>>();
    if args.len() < 2 {
        print_help(&args[0]);
        return Ok(());
    }

    match args[1].as_str() {
        "keygen" => {
            if args.len() != 4 {
                return Err("usage: tfhe_tool keygen <client.key> <server.key>".into());
            }
            let config = ConfigBuilder::default()
                .enable_compression(COMP_PARAM_MESSAGE_2_CARRY_2_KS_PBS_TUNIFORM_2M128)
                .build();
            let (client_key, server_key) = generate_keys(config);
            let server_key = force_deterministic_pbs(server_key);
            write_client_key(&client_key, &args[2])?;
            write_server_key(&server_key, &args[3])?;
            println!("client_key={}", args[2]);
            println!("server_key={}", args[3]);
        }
        "encrypt-u32" => {
            if args.len() != 5 {
                return Err(
                    "usage: tfhe_tool encrypt-u32 <client.key> <value> <ciphertext.bin>".into(),
                );
            }
            let client_key = read_client_key(&args[2])?;
            let value = args[3].parse::<u32>()?;
            let ciphertext = FheUint32::encrypt(value, &client_key);
            write_u32_ciphertext(&ciphertext, &args[4])?;
            println!("ciphertext={}", args[4]);
        }
        "encrypt-u32-compressed" => {
            if args.len() != 5 {
                return Err(
                    "usage: tfhe_tool encrypt-u32-compressed <client.key> <value> <ciphertext.bin>"
                        .into(),
                );
            }
            let client_key = read_client_key(&args[2])?;
            let value = args[3].parse::<u32>()?;
            let ciphertext = CompressedFheUint32::encrypt(value, &client_key);
            write_compressed_u32_ciphertext(&ciphertext, &args[4])?;
            println!("ciphertext={}", args[4]);
        }
        "encrypt-bool" => {
            if args.len() != 5 {
                return Err(
                    "usage: tfhe_tool encrypt-bool <client.key> <true|false> <ciphertext.bin>"
                        .into(),
                );
            }
            let client_key = read_client_key(&args[2])?;
            let value = args[3].parse::<bool>()?;
            let ciphertext = FheBool::encrypt(value, &client_key);
            write_bool_ciphertext(&ciphertext, &args[4])?;
            println!("ciphertext={}", args[4]);
        }
        "encrypt-bool-compressed" => {
            if args.len() != 5 {
                return Err(
                    "usage: tfhe_tool encrypt-bool-compressed <client.key> <true|false> <ciphertext.bin>".into(),
                );
            }
            let client_key = read_client_key(&args[2])?;
            let value = args[3].parse::<bool>()?;
            let ciphertext = CompressedFheBool::encrypt(value, &client_key);
            write_compressed_bool_ciphertext(&ciphertext, &args[4])?;
            println!("ciphertext={}", args[4]);
        }
        "decrypt-u32" => {
            if args.len() != 4 {
                return Err("usage: tfhe_tool decrypt-u32 <client.key> <ciphertext.bin>".into());
            }
            let client_key = read_client_key(&args[2])?;
            let ciphertext = read_u32_ciphertext(&args[3])?;
            let value: u32 = ciphertext.decrypt(&client_key);
            println!("{value}");
        }
        "decrypt-bool" => {
            if args.len() != 4 {
                return Err("usage: tfhe_tool decrypt-bool <client.key> <ciphertext.bin>".into());
            }
            let client_key = read_client_key(&args[2])?;
            let ciphertext = read_bool_ciphertext(&args[3])?;
            let value: bool = ciphertext.decrypt(&client_key);
            println!("{value}");
        }
        "dispatch-add-u32" => {
            if args.len() != 6 {
                return Err(
                    "usage: tfhe_tool dispatch-add-u32 <server.key> <left.bin> <right.bin> <result.bin>".into(),
                );
            }
            dispatch_binary(&args[2], 0x01, &args[3], &args[4], &args[5])?;
        }
        "dispatch-sub-u32" => {
            if args.len() != 6 {
                return Err(
                    "usage: tfhe_tool dispatch-sub-u32 <server.key> <left.bin> <right.bin> <result.bin>".into(),
                );
            }
            dispatch_binary(&args[2], 0x02, &args[3], &args[4], &args[5])?;
        }
        "dispatch-mul-scalar-u32" => {
            if args.len() != 6 {
                return Err(
                    "usage: tfhe_tool dispatch-mul-scalar-u32 <server.key> <left.bin> <scalar> <result.bin>".into(),
                );
            }
            std::env::set_var("FHEBC_TFHE_SERVER_KEY_PATH", &args[2]);
            let left = fs::read(&args[3])?;
            let scalar = args[4].parse::<u64>()?.to_be_bytes().to_vec();
            write_dispatch_result(0x03, vec![left, scalar], &args[5])?;
        }
        "proof-mul-scalar-u32" => {
            if args.len() != 6 {
                return Err(
                    "usage: tfhe_tool proof-mul-scalar-u32 <server.key> <left.bin> <scalar> <result.bin>".into(),
                );
            }
            std::env::set_var("FHEBC_TFHE_SERVER_KEY_PATH", &args[2]);
            let input_bytes = fs::read(&args[3])?;
            let compressed_output = strip_magic(&input_bytes, COMPRESSED_U32_MAGIC).is_some()
                || strip_magic(&input_bytes, PACKED_U32_MAGIC).is_some();
            let left = read_u32_ciphertext(&args[3])?;
            let scalar = args[4].parse::<u32>()?;
            let result = &left * scalar;
            if compressed_output {
                let mut builder = CompressedCiphertextListBuilder::new();
                builder.push(result);
                let packed = builder.build()?;
                let mut out = Vec::new();
                safe_serialize(&packed, &mut out, MAX_CIPHERTEXT_BYTES)?;
                write_bytes(&args[5], wrap_magic(PACKED_U32_MAGIC, out))?;
            } else {
                write_u32_ciphertext(&result, &args[5])?;
            }
            println!("ciphertext={}", args[5]);
        }
        "dispatch-eq-u32" => {
            if args.len() != 6 {
                return Err(
                    "usage: tfhe_tool dispatch-eq-u32 <server.key> <left.bin> <right.bin> <result.bin>".into(),
                );
            }
            dispatch_binary(&args[2], 0x04, &args[3], &args[4], &args[5])?;
        }
        "dispatch-lt-u32" => {
            if args.len() != 6 {
                return Err(
                    "usage: tfhe_tool dispatch-lt-u32 <server.key> <left.bin> <right.bin> <result.bin>".into(),
                );
            }
            dispatch_binary(&args[2], 0x05, &args[3], &args[4], &args[5])?;
        }
        "dispatch-mean-u32" => {
            if args.len() < 6 {
                return Err(
                    "usage: tfhe_tool dispatch-mean-u32 <server.key> <result.bin> <input1.bin> <input2.bin> [...]".into(),
                );
            }
            dispatch_many(&args[2], 0x07, &args[3], &args[4..])?;
        }
        "dispatch-max-u32" => {
            if args.len() < 6 {
                return Err(
                    "usage: tfhe_tool dispatch-max-u32 <server.key> <result.bin> <input1.bin> <input2.bin> [...]".into(),
                );
            }
            dispatch_many(&args[2], 0x08, &args[3], &args[4..])?;
        }
        "self-test" => {
            if args.len() != 4 {
                return Err("usage: tfhe_tool self-test <client.key> <server.key>".into());
            }
            let client_key = read_client_key(&args[2])?;
            let server_key = read_server_key(&args[3])?;
            set_server_key(server_key);
            let a = FheUint32::encrypt(40u32, &client_key);
            let b = FheUint32::encrypt(2u32, &client_key);
            let result = &a + &b;
            let clear: u32 = result.decrypt(&client_key);
            if clear != 42 {
                return Err(format!("self-test failed: expected 42, got {clear}").into());
            }
            println!("ok");
        }
        _ => print_help(&args[0]),
    }

    Ok(())
}

fn print_help(bin: &str) {
    println!(
        "Usage:
  {bin} keygen <client.key> <server.key>
  {bin} encrypt-u32 <client.key> <value> <ciphertext.bin>
  {bin} encrypt-u32-compressed <client.key> <value> <ciphertext.bin>
  {bin} encrypt-bool <client.key> <true|false> <ciphertext.bin>
  {bin} encrypt-bool-compressed <client.key> <true|false> <ciphertext.bin>
  {bin} decrypt-u32 <client.key> <ciphertext.bin>
  {bin} decrypt-bool <client.key> <ciphertext.bin>
  {bin} dispatch-add-u32 <server.key> <left.bin> <right.bin> <result.bin>
  {bin} dispatch-sub-u32 <server.key> <left.bin> <right.bin> <result.bin>
  {bin} dispatch-mul-scalar-u32 <server.key> <left.bin> <scalar> <result.bin>
  {bin} proof-mul-scalar-u32 <server.key> <left.bin> <scalar> <result.bin>
  {bin} dispatch-eq-u32 <server.key> <left.bin> <right.bin> <result.bin>
  {bin} dispatch-lt-u32 <server.key> <left.bin> <right.bin> <result.bin>
  {bin} dispatch-mean-u32 <server.key> <result.bin> <input1.bin> <input2.bin> [...]
  {bin} dispatch-max-u32 <server.key> <result.bin> <input1.bin> <input2.bin> [...]
  {bin} self-test <client.key> <server.key>"
    );
}

fn dispatch_binary(
    server_key_path: &str,
    operation: u8,
    left_path: &str,
    right_path: &str,
    out_path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    std::env::set_var("FHEBC_TFHE_SERVER_KEY_PATH", server_key_path);
    let left = std::fs::read(left_path)?;
    let right = std::fs::read(right_path)?;
    write_dispatch_result(operation, vec![left, right], out_path)
}

fn dispatch_many(
    server_key_path: &str,
    operation: u8,
    out_path: &str,
    input_paths: &[String],
) -> Result<(), Box<dyn std::error::Error>> {
    std::env::set_var("FHEBC_TFHE_SERVER_KEY_PATH", server_key_path);
    let mut operands = Vec::with_capacity(input_paths.len());
    for path in input_paths {
        operands.push(std::fs::read(path)?);
    }
    write_dispatch_result(operation, operands, out_path)
}

fn write_dispatch_result(
    operation: u8,
    operands: Vec<Vec<u8>>,
    out_path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let request = canonical_request(operation, operands)?;
    let response = besu_fhe_native::dispatch_canonical(&request);
    let result = response_payload(&response)?;
    if let Some(parent) = std::path::Path::new(out_path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(out_path, result)?;
    println!("ciphertext={out_path}");
    Ok(())
}

fn canonical_request(
    operation: u8,
    operands: Vec<Vec<u8>>,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if operands.len() > u8::MAX as usize {
        return Err("too many operands".into());
    }
    let mut out = Vec::new();
    out.push(0x01);
    out.push(operation);
    out.push(0x04);
    out.extend_from_slice(&0x0001u16.to_be_bytes());
    out.push(operands.len() as u8);
    for operand in operands {
        if operand.len() > u32::MAX as usize {
            return Err("operand too large".into());
        }
        out.extend_from_slice(&(operand.len() as u32).to_be_bytes());
        out.extend_from_slice(&operand);
    }
    Ok(out)
}

fn response_payload(response: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if response.len() < 8 {
        return Err("malformed response".into());
    }
    if response[0] != 0 {
        return Err(format!("dispatcher returned status {}", response[0]).into());
    }
    let len = u32::from_be_bytes(response[4..8].try_into()?) as usize;
    if response.len() != 8 + len {
        return Err("malformed response length".into());
    }
    Ok(response[8..].to_vec())
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
