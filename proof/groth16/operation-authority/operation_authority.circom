pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";

template OperationAuthority() {
    signal input coprocessor_secret;
    signal input operation_digest_hi;
    signal input operation_digest_lo;
    signal input authority_commitment;
    signal input attestation_hash;

    component authority = Poseidon(1);
    authority.inputs[0] <== coprocessor_secret;
    authority.out === authority_commitment;

    component attestation = Poseidon(3);
    attestation.inputs[0] <== coprocessor_secret;
    attestation.inputs[1] <== operation_digest_hi;
    attestation.inputs[2] <== operation_digest_lo;
    attestation.out === attestation_hash;
}

component main {
    public [
        operation_digest_hi,
        operation_digest_lo,
        authority_commitment,
        attestation_hash
    ]
} = OperationAuthority();
