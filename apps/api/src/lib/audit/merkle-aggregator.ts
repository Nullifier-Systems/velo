import { createHash } from "node:crypto";

export function computeMerkleRoot(hashes: string[]): string {
    if (hashes.length === 0) return "0".repeat(64);
    if (hashes.length === 1) return hashes[0];

    const nextLevel: string[] = [];
    for (let i = 0; i < hashes.length; i += 2) {
        const left = hashes[i];
        const right = i + 1 < hashes.length ? hashes[i + 1] : left;
        const combined = createHash("sha256").update(left + right).digest("hex");
        nextLevel.push(combined);
    }
    return computeMerkleRoot(nextLevel);
}

export function computeMerkleProof(hashes: string[], index: number): string[] {
    if (hashes.length <= 1) return [];

    const proof: string[] = [];
    let currentIndex = index;
    let currentLevel = hashes;

    while (currentLevel.length > 1) {
        const nextLevel: string[] = [];
        for (let i = 0; i < currentLevel.length; i += 2) {
            const left = currentLevel[i];
            const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left;
            
            if (i === currentIndex || i + 1 === currentIndex) {
                const sibling = i === currentIndex ? right : left;
                proof.push(sibling);
            }
            
            const combined = createHash("sha256").update(left + right).digest("hex");
            nextLevel.push(combined);
        }
        currentIndex = Math.floor(currentIndex / 2);
        currentLevel = nextLevel;
    }

    return proof;
}

export function verifyMerkleProof(leafHash: string, root: string, proof: string[], index: number): boolean {
    let currentHash = leafHash;
    let currentIndex = index;

    for (const sibling of proof) {
        if (currentIndex % 2 === 0) {
            currentHash = createHash("sha256").update(currentHash + sibling).digest("hex");
        } else {
            currentHash = createHash("sha256").update(sibling + currentHash).digest("hex");
        }
        currentIndex = Math.floor(currentIndex / 2);
    }

    return currentHash === root;
}
