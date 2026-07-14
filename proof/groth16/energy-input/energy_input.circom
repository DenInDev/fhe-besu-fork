pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

template EnergyInputValidation() {
    signal input plaintext;
    signal input salt;
    signal input ciphertext_hash_hi;
    signal input ciphertext_hash_lo;
    signal input owner;
    signal input min_value;
    signal input max_value;
    signal input metadata_hash;

    component ge_min = GreaterEqThan(64);
    ge_min.in[0] <== plaintext;
    ge_min.in[1] <== min_value;
    ge_min.out === 1;

    component le_max = LessEqThan(64);
    le_max.in[0] <== plaintext;
    le_max.in[1] <== max_value;
    le_max.out === 1;

    component poseidon = Poseidon(5);
    poseidon.inputs[0] <== plaintext;
    poseidon.inputs[1] <== salt;
    poseidon.inputs[2] <== owner;
    poseidon.inputs[3] <== ciphertext_hash_hi;
    poseidon.inputs[4] <== ciphertext_hash_lo;
    poseidon.out === metadata_hash;
}

component main {
    public [
        ciphertext_hash_hi,
        ciphertext_hash_lo,
        owner,
        min_value,
        max_value,
        metadata_hash
    ]
} = EnergyInputValidation();
