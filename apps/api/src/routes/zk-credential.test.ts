import { describe, it, expect } from "vitest";
import crypto from "crypto";

// Helper to compute sha256 hash as buffer or hex
function sha256(data: string | Buffer): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

function sha256Two(left: Buffer, right: Buffer): Buffer {
  const combined = Buffer.concat([left, right]);
  return sha256(combined);
}

const TREE_DEPTH = 8;
const ZERO_VALUE = sha256(""); // Default empty leaf

// Generate default zero-values for each level of the tree
const ZERO_VALUES: Buffer[] = [];
let currentZero = ZERO_VALUE;
for (let i = 0; i < TREE_DEPTH; i++) {
  ZERO_VALUES.push(currentZero);
  currentZero = sha256Two(currentZero, currentZero);
}

/**
 * TypeScript Mock of the Soroban Verifier Registry Contract.
 * Implements the exact same Merkle tree calculations, state transitions,
 * and double-spend nullifier checks as the Rust contract.
 */
class VerifierRegistryContract {
  public nextIndex = 0;
  public filledSubtrees: Buffer[] = [...ZERO_VALUES];
  public validRoots = new Set<string>();
  public spentNullifiers = new Set<string>();
  
  constructor() {
    // Register the empty tree root as a valid initial root
    const initialRoot = this.calculateRoot(this.filledSubtrees, 0);
    this.validRoots.add(initialRoot.toString("hex"));
  }

  /**
   * Mock Soroban contract buy() function.
   * Inserts commitment and registers new Merkle root.
   */
  public buy(commitment: Buffer): Buffer {
    if (this.nextIndex >= 2 ** TREE_DEPTH) {
      throw new Error("TreeFull");
    }

    let current = commitment;
    let index = this.nextIndex;

    for (let i = 0; i < TREE_DEPTH; i++) {
      if (index % 2 === 0) {
        this.filledSubtrees[i] = current;
        break;
      } else {
        const left = this.filledSubtrees[i];
        current = sha256Two(left, current);
      }
      index = Math.floor(index / 2);
    }

    this.nextIndex += 1;

    const newRoot = this.calculateRoot(this.filledSubtrees, this.nextIndex, commitment);
    this.validRoots.add(newRoot.toString("hex"));
    return newRoot;
  }

  /**
   * Mock Soroban contract spend() function.
   * Performs root check, nullifier spent check, and ZK verifier check.
   */
  public spend(
    proof: {
      secret: string;
      pathIndices: number[];
      pathElements: Buffer[];
    },
    root: Buffer,
    nullifier: Buffer
  ): void {
    const rootHex = root.toString("hex");
    const nullifierHex = nullifier.toString("hex");

    // 1. Verify root exists in registry history
    if (!this.validRoots.has(rootHex)) {
      throw new Error("RootNotFound");
    }

    // 2. Verify nullifier hasn't been spent
    if (this.spentNullifiers.has(nullifierHex)) {
      throw new Error("NullifierAlreadySpent");
    }

    // 3. Verify ZK Proof (Simulates the Noir circuit verification logic)
    const isValid = this.verifyZkProof(proof, root, nullifier);
    if (!isValid) {
      throw new Error("InvalidProof");
    }

    // 4. Mark nullifier as spent
    this.spentNullifiers.add(nullifierHex);
  }

  /**
   * Helper to calculate the current root using filledSubtrees
   */
  private calculateRoot(filled: Buffer[], nextIndex: number, leaf: Buffer): Buffer {
    if (nextIndex === 0) {
      return ZERO_VALUES[TREE_DEPTH - 1];
    }
    let current = leaf;
    let index = nextIndex - 1;

    for (let i = 0; i < TREE_DEPTH; i++) {
      if (((index >> i) % 2) === 1) {
        const left = filled[i];
        current = sha256Two(left, current);
      } else {
        const right = ZERO_VALUES[i];
        current = sha256Two(current, right);
      }
    }
    return current;
  }

  /**
   * Noir Circuit verification simulation logic.
   * Asserts the cryptographic soundness of inputs and Merkle inclusion.
   */
  private verifyZkProof(
    proof: {
      secret: string;
      pathIndices: number[];
      pathElements: Buffer[];
    },
    root: Buffer,
    nullifier: Buffer
  ): boolean {
    const secretBuf = Buffer.from(proof.secret, "hex");
    
    // 1. Compute commitment = hash(secret)
    const computedCommitment = sha256(secretBuf);

    // 2. Compute nullifier = hash(secret + "1")
    const computedNullifier = sha256(Buffer.concat([secretBuf, Buffer.from("1")]));
    if (!computedNullifier.equals(nullifier)) {
      return false;
    }

    // 3. Walk up the Merkle path
    let current = computedCommitment;
    for (let i = 0; i < TREE_DEPTH; i++) {
      const isRight = proof.pathIndices[i] === 1;
      const sibling = proof.pathElements[i];

      if (isRight) {
        current = sha256Two(sibling, current);
      } else {
        current = sha256Two(current, sibling);
      }
    }

    // 4. Check if reconstructed root matches target root
    return current.equals(root);
  }
}

/**
 * Off-chain Client Merkle Tree to assist in generating proof path elements
 */
class ClientMerkleTree {
  public leaves: Buffer[] = [];

  public insert(leaf: Buffer) {
    this.leaves.push(leaf);
  }

  public getRoot(): Buffer {
    return this.getLevelRoot(this.leaves, TREE_DEPTH);
  }

  private getLevelRoot(leaves: Buffer[], depth: number): Buffer {
    let currentLevel = [...leaves];
    const totalLeaves = 2 ** depth;
    
    // Pad leaves up to depth boundary
    while (currentLevel.length < totalLeaves) {
      currentLevel.push(ZERO_VALUE);
    }

    for (let d = 0; d < depth; d++) {
      const nextLevel: Buffer[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        nextLevel.push(sha256Two(currentLevel[i], currentLevel[i + 1]));
      }
      currentLevel = nextLevel;
    }
    return currentLevel[0];
  }

  public getProof(index: number): { pathIndices: number[]; pathElements: Buffer[] } {
    const pathIndices: number[] = [];
    const pathElements: Buffer[] = [];
    let currentLevel = [...this.leaves];
    const totalLeaves = 2 ** TREE_DEPTH;

    while (currentLevel.length < totalLeaves) {
      currentLevel.push(ZERO_VALUE);
    }

    let currentIndex = index;
    for (let d = 0; d < TREE_DEPTH; d++) {
      const isRight = currentIndex % 2 === 1;
      pathIndices.push(isRight ? 1 : 0);

      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      pathElements.push(currentLevel[siblingIndex]);

      const nextLevel: Buffer[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        nextLevel.push(sha256Two(currentLevel[i], currentLevel[i + 1]));
      }
      currentLevel = nextLevel;
      currentIndex = Math.floor(currentIndex / 2);
    }

    return { pathIndices, pathElements };
  }
}

describe("Anonymous Access Credential System - End-to-End Flow", () => {
  it("should buy a credential, spend it, and reject double spend via nullifier", () => {
    const verifierRegistry = new VerifierRegistryContract();
    const clientTree = new ClientMerkleTree();

    // 1. Participant generates a secret and computes commitment/nullifier
    const secret = crypto.randomBytes(32).toString("hex");
    const secretBuf = Buffer.from(secret, "hex");
    const commitment = sha256(secretBuf);
    const nullifier = sha256(Buffer.concat([secretBuf, Buffer.from("1")]));

    // 2. Participant buys credential
    // On-chain contract records the commitment and returns the new Merkle root
    const rootAfterBuy = verifierRegistry.buy(commitment);
    clientTree.insert(commitment);

    const clientRoot = clientTree.getRoot();
    expect(rootAfterBuy.equals(clientRoot)).toBe(true);

    // 3. Generate ZK Proof details (Merkle path)
    const leafIndex = 0;
    const { pathIndices, pathElements } = clientTree.getProof(leafIndex);
    const proof = {
      secret,
      pathIndices,
      pathElements,
    };

    // Verify proof works and we can spend the credential
    expect(() => {
      verifierRegistry.spend(proof, rootAfterBuy, nullifier);
    }).not.toThrow();

    // 4. Confirm a second spend attempt with the same credential/nullifier is rejected
    expect(() => {
      verifierRegistry.spend(proof, rootAfterBuy, nullifier);
    }).toThrow("NullifierAlreadySpent");
  });
});
