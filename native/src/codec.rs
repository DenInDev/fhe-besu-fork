pub const VERSION: u8 = 1;

pub const PARAM_TFHE_UINT32_V1: u16 = 0x0001;

pub const MAX_OPERAND_COUNT: usize = 64;
pub const MAX_CIPHERTEXT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_REQUEST_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Status {
    Ok = 0x00,
    InvalidEncoding = 0x01,
    InvalidCiphertext = 0x02,
    ParameterSetMismatch = 0x03,
    UnsupportedOperation = 0x04,
    InputTooLarge = 0x05,
    InternalError = 0x06,
}

impl Status {
    pub fn code(self) -> u8 {
        self as u8
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Operation {
    Add = 0x01,
    Sub = 0x02,
    MulScalar = 0x03,
    Eq = 0x04,
    Lt = 0x05,
    Select = 0x06,
    Mean = 0x07,
    Max = 0x08,
}

impl TryFrom<u8> for Operation {
    type Error = Status;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0x01 => Ok(Self::Add),
            0x02 => Ok(Self::Sub),
            0x03 => Ok(Self::MulScalar),
            0x04 => Ok(Self::Eq),
            0x05 => Ok(Self::Lt),
            0x06 => Ok(Self::Select),
            0x07 => Ok(Self::Mean),
            0x08 => Ok(Self::Max),
            _ => Err(Status::UnsupportedOperation),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FheType {
    Ebool = 0x01,
    Euint8 = 0x02,
    Euint16 = 0x03,
    Euint32 = 0x04,
}

impl TryFrom<u8> for FheType {
    type Error = Status;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0x01 => Ok(Self::Ebool),
            0x02 => Ok(Self::Euint8),
            0x03 => Ok(Self::Euint16),
            0x04 => Ok(Self::Euint32),
            _ => Err(Status::UnsupportedOperation),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub operation: Operation,
    pub input_type: FheType,
    pub parameter_set: u16,
    pub operands: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub output_type: FheType,
    pub parameter_set: u16,
    pub result: Vec<u8>,
}

pub fn decode_request(input: &[u8]) -> Result<Request, Status> {
    if input.len() < 6 || input.len() > MAX_REQUEST_BYTES {
        return Err(Status::InvalidEncoding);
    }
    if input[0] != VERSION {
        return Err(Status::InvalidEncoding);
    }

    let operation = Operation::try_from(input[1])?;
    let input_type = FheType::try_from(input[2])?;
    let parameter_set = read_u16(input, 3)?;
    let operand_count = input[5] as usize;
    if operand_count > MAX_OPERAND_COUNT {
        return Err(Status::InvalidEncoding);
    }

    let mut offset = 6usize;
    let mut operands = Vec::with_capacity(operand_count);
    for _ in 0..operand_count {
        let length = read_u32(input, offset)? as usize;
        offset += 4;
        if length > MAX_CIPHERTEXT_BYTES {
            return Err(Status::InputTooLarge);
        }
        if offset
            .checked_add(length)
            .is_none_or(|end| end > input.len())
        {
            return Err(Status::InvalidEncoding);
        }
        operands.push(input[offset..offset + length].to_vec());
        offset += length;
    }

    if offset != input.len() {
        return Err(Status::InvalidEncoding);
    }

    Ok(Request {
        operation,
        input_type,
        parameter_set,
        operands,
    })
}

pub fn encode_success(response: Response) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + response.result.len());
    out.push(Status::Ok.code());
    out.push(response.output_type as u8);
    out.extend_from_slice(&response.parameter_set.to_be_bytes());
    out.extend_from_slice(&(response.result.len() as u32).to_be_bytes());
    out.extend_from_slice(&response.result);
    out
}

pub fn encode_error(status: Status) -> Vec<u8> {
    let mut out = Vec::with_capacity(8);
    out.push(status.code());
    out.push(0);
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&0u32.to_be_bytes());
    out
}

fn read_u16(input: &[u8], offset: usize) -> Result<u16, Status> {
    if offset.checked_add(2).is_none_or(|end| end > input.len()) {
        return Err(Status::InvalidEncoding);
    }
    Ok(u16::from_be_bytes([input[offset], input[offset + 1]]))
}

fn read_u32(input: &[u8], offset: usize) -> Result<u32, Status> {
    if offset.checked_add(4).is_none_or(|end| end > input.len()) {
        return Err(Status::InvalidEncoding);
    }
    Ok(u32::from_be_bytes([
        input[offset],
        input[offset + 1],
        input[offset + 2],
        input[offset + 3],
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_trailing_bytes() {
        let input = [
            VERSION,
            Operation::Add as u8,
            FheType::Euint32 as u8,
            0,
            1,
            0,
            99,
        ];
        assert_eq!(decode_request(&input), Err(Status::InvalidEncoding));
    }

    #[test]
    fn encodes_error_as_fixed_header() {
        assert_eq!(
            encode_error(Status::UnsupportedOperation),
            vec![Status::UnsupportedOperation.code(), 0, 0, 0, 0, 0, 0, 0]
        );
    }
}
