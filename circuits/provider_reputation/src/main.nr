// Provider Reputation & Identity ZK Verifier Circuit in Noir
//
// Statement: Proves that a provider holding a secret key `sk` with raw reputation `reputation_score`:
// 1. Has a score exceeding threshold: `reputation_score >= min_reputation`.
// 2. Belongs to the verified identity Merkle tree with public root `identity_root`.
// 3. Generates a deterministic epoch nullifier: `nullifier_hash == Poseidon(sk, epoch_id)`.

use dep::std;

global TREE_DEPTH: u32 = 8;

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
    sk: Field,
    reputation_score: u32,
    merkle_path: [Field; 8],
    path_indices: [u1; 8],
    
    // Public inputs
    identity_root: pub Field,
    min_reputation: pub u32,
    epoch_id: pub Field,
    nullifier_hash: pub Field
) {
    // 1. Prove reputation threshold R >= R_min
    assert(reputation_score >= min_reputation);

    // 2. Compute identity commitment from secret key
    let identity_commitment = std::hash::poseidon::bn254::hash_1([sk]);

    // 3. Reconstruct Merkle identity root from leaf & proof path
    let computed_root = compute_merkle_root(identity_commitment, merkle_path, path_indices);
    assert(computed_root == identity_root);

    // 4. Compute unique single-use epoch nullifier hash: Poseidon(sk || epoch_id)
    let computed_nullifier = std::hash::poseidon::bn254::hash_2([sk, epoch_id]);
    assert(computed_nullifier == nullifier_hash);
}

#[test]
fn test_valid_reputation_proof() {
    let sk = 0x1337;
    let score: u32 = 850;
    let min_score: u32 = 500;
    let epoch = 20260726;

    let commitment = std::hash::poseidon::bn254::hash_1([sk]);
    let path = [0; 8];
    let indices = [0; 8];

    let root = compute_merkle_root(commitment, path, indices);
    let nullifier = std::hash::poseidon::bn254::hash_2([sk, epoch]);

    main(sk, score, path, indices, root, min_score, epoch, nullifier);
}
