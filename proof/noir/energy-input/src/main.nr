use poseidon::poseidon2::Poseidon2;

fn main(
    plaintext: u64,
    salt: Field,
    ciphertext_hash_hi: pub Field,
    ciphertext_hash_lo: pub Field,
    owner: pub Field,
    min_value: pub u64,
    max_value: pub u64,
) -> pub Field {
    assert(plaintext >= min_value);
    assert(plaintext <= max_value);

    let commitment_inputs = [
        plaintext as Field,
        salt,
        owner,
        ciphertext_hash_hi,
        ciphertext_hash_lo,
    ];
    Poseidon2::hash(commitment_inputs, 5)
}
