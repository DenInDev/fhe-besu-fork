use crate::codec::{FheType, Request, Response, Status, PARAM_TFHE_UINT32_V1};

pub trait FheBackend {
    fn execute(&self, request: &Request) -> Result<Response, Status>;
}

pub fn validate_uint32_request(request: &Request) -> Result<(), Status> {
    if request.parameter_set != PARAM_TFHE_UINT32_V1 {
        return Err(Status::ParameterSetMismatch);
    }
    if request.input_type != FheType::Euint32 {
        return Err(Status::UnsupportedOperation);
    }
    Ok(())
}

pub fn response(output_type: FheType, result: Vec<u8>) -> Response {
    Response {
        output_type,
        parameter_set: PARAM_TFHE_UINT32_V1,
        result,
    }
}

pub fn require_operand_count(request: &Request, expected: usize) -> Result<(), Status> {
    if request.operands.len() == expected {
        Ok(())
    } else {
        Err(Status::InvalidEncoding)
    }
}

pub fn require_nonempty_operands(request: &Request) -> Result<(), Status> {
    if request.operands.is_empty() {
        Err(Status::InvalidEncoding)
    } else {
        Ok(())
    }
}
