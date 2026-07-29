// Anonymous Single-Use Access Credential Verifier Circuit in Noir
//
// Proves that:
// 1. The prover knows a private `secret` corresponding to a leaf commitment = Poseidon(secret).
// 2. The leaf commitment belongs to a Merkle tree with public root `root` at path `merkle_path`.
// 3. The public `nullifier_hash` is correctly derived as Poseidon(secret, domain_separator).

use dep::std;

global TREE_DEPTH: u32 = 8;
global NULLIFIER_DOMAIN: Field = 0x4e554c4c; // "NULL" domain separator

fn compute_merkle_root(leaf: Field, merkle_path: [Field; 8], path_indices: [u1; 8]) -> Field {
    let mut current = leaf;
    for i in 0..8 {
        let sibling = merkle_path[i];
        let is_right = path_indices[i];
        
        let left = if is_right == 1 { sibling } else { current };
        let right = if is_right == 1 { current } else { sibling };
        
        current = std::hash::poseidon::bn254::hash_2([left, right]);
    }
    current
}

fn main(
    // Private inputs
    secret: Field,
    merkle_path: [Field; 8],
    path_indices: [u1; 8],
    
    // Public inputs
    root: pub Field,
    nullifier_hash: pub Field
) {
    // 1. Compute leaf commitment from secret
    let commitment = std::hash::poseidon::bn254::hash_1([secret]);

    // 2. Reconstruct Merkle root from leaf & proof path
    let computed_root = compute_merkle_root(commitment, merkle_path, path_indices);
    assert(computed_root == root);

    // 3. Compute unique single-use nullifier hash to prevent double spending
    let computed_nullifier = std::hash::poseidon::bn254::hash_2([secret, NULLIFIER_DOMAIN]);
    assert(computed_nullifier == nullifier_hash);
}

#[test]
fn test_valid_credential_proof() {
    let secret = 42;
    let commitment = std::hash::poseidon::bn254::hash_1([secret]);
    
    let path = [0; 8];
    let indices = [0; 8];
    
    let root = compute_merkle_root(commitment, path, indices);
    let nullifier = std::hash::poseidon::bn254::hash_2([secret, NULLIFIER_DOMAIN]);

    main(secret, path, indices, root, nullifier);
}
