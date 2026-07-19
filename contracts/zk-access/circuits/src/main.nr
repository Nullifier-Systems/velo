use dep::std;

// We use a fixed Merkle tree depth of 8 for simplicity in this minimal access system.
global TREE_DEPTH: u32 = 8;

fn main(
    root: pub Field,
    nullifier: pub Field,
    secret: Field,
    path_indices: [u1; TREE_DEPTH],
    path_elements: [Field; TREE_DEPTH]
) {
    // 1. Compute commitment = Poseidon(secret)
    let commitment = std::hash::poseidon::bn254::hash_1([secret]);

    // 2. Compute nullifier = Poseidon(secret, 1) to prevent double spending
    let computed_nullifier = std::hash::poseidon::bn254::hash_2([secret, 1]);
    assert(nullifier == computed_nullifier);

    // 3. Compute Merkle root from commitment and path elements
    let mut current = commitment;
    for i in 0..TREE_DEPTH {
        let (left, right) = if path_indices[i] == 0 {
            (current, path_elements[i])
        } else {
            (path_elements[i], current)
        };
        current = std::hash::poseidon::bn254::hash_2([left, right]);
    }

    // 4. Verify that the calculated root matches the public root
    assert(root == current);
}
