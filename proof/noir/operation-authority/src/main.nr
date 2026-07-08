use poseidon::poseidon2::Poseidon2;

fn main(
    coprocessor_secret: Field,
    operation_digest_hi: pub Field,
    operation_digest_lo: pub Field,
) -> pub [Field; 2] {
    let commitment_inputs = [coprocessor_secret];
    let authority_commitment = Poseidon2::hash(commitment_inputs, 1);

    let attestation_inputs = [
        coprocessor_secret,
        operation_digest_hi,
        operation_digest_lo,
    ];
    let attestation_hash = Poseidon2::hash(attestation_inputs, 3);

    [authority_commitment, attestation_hash]
}
