/**
 * Double-Ratchet & X3DH End-to-End Encryption Types
 * Single source of truth shared across API and Frontend.
 */

export interface E2EEIdentityKeyPair {
  address: string;
  identityPublicKey: string; // base64
  identitySecretKey?: string; // base64 (client-side only, never sent to server)
}

export interface E2EESignedPrekey {
  id: number;
  publicKey: string; // base64
  signature: string; // base64
  secretKey?: string; // base64 (client-side only)
}

export interface E2EEOneTimePrekey {
  id: number;
  publicKey: string; // base64
  secretKey?: string; // base64 (client-side only)
}

export interface E2EEPrekeyBundle {
  address: string;
  identityPublicKey: string; // base64
  signedPrekey: {
    id: number;
    publicKey: string; // base64
    signature: string; // base64
  };
  oneTimePrekey?: {
    id: number;
    publicKey: string; // base64
  };
}

export interface E2EEPrekeyUploadRequest {
  address: string;
  identityPublicKey: string; // base64
  signedPrekey: {
    id: number;
    publicKey: string; // base64
    signature: string; // base64
  };
  oneTimePrekeys: Array<{
    id: number;
    publicKey: string; // base64
  }>;
}

export interface X3DHSessionInit {
  senderAddress: string;
  senderIdentityKey: string; // base64
  ephemeralKey: string; // base64
  signedPrekeyId: number;
  oneTimePrekeyId?: number;
}

export interface DoubleRatchetHeader {
  dhPub: string; // Base64 X25519 DH public key of sender for this ratchet step
  n: number;     // Message counter in current sending chain
  pn: number;    // Number of messages in previous sending chain
}

export interface E2EEMessagePayload {
  header: DoubleRatchetHeader;
  ciphertext: string; // Base64 AES-256-GCM / ChaCha20-Poly1305 ciphertext
  nonce: string;      // Base64 unique 96-bit nonce
  x3dhInit?: X3DHSessionInit; // Attached on session-initiating message
}

export interface EncryptedMediaChunk {
  chunkIndex: number;
  totalChunks: number;
  ciphertext: string; // Base64
  nonce: string;      // Base64
  mimeType: string;
}
