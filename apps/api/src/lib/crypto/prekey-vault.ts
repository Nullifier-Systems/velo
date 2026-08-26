import type { Pool } from "pg";
import type { E2EEPrekeyBundle, E2EEPrekeyUploadRequest } from "@velo/shared";

interface StoredIdentityRecord {
  address: string;
  identityPublicKey: string;
  signedPrekeyId: number;
  signedPrekeyPublicKey: string;
  signedPrekeySignature: string;
}

interface StoredOneTimePrekey {
  address: string;
  keyId: number;
  publicKey: string;
}

const memoryIdentityKeys = new Map<string, StoredIdentityRecord>();
const memoryOneTimePrekeys = new Map<string, StoredOneTimePrekey[]>();

export async function savePrekeyBundle(
  upload: E2EEPrekeyUploadRequest,
  pool?: Pool
): Promise<void> {
  const { address, identityPublicKey, signedPrekey, oneTimePrekeys } = upload;

  // Save to memory
  memoryIdentityKeys.set(address, {
    address,
    identityPublicKey,
    signedPrekeyId: signedPrekey.id,
    signedPrekeyPublicKey: signedPrekey.publicKey,
    signedPrekeySignature: signedPrekey.signature,
  });

  const existingOTPs = memoryOneTimePrekeys.get(address) ?? [];
  const newOTPs = oneTimePrekeys.map((otp) => ({ address, keyId: otp.id, publicKey: otp.publicKey }));
  memoryOneTimePrekeys.set(address, [...existingOTPs, ...newOTPs]);

  // Save to Postgres if pool is provided
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO e2ee_identity_keys (address, identity_public_key, signed_prekey_id, signed_prekey_public_key, signed_prekey_signature, updated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
         ON CONFLICT (address) DO UPDATE
         SET identity_public_key = EXCLUDED.identity_public_key,
             signed_prekey_id = EXCLUDED.signed_prekey_id,
             signed_prekey_public_key = EXCLUDED.signed_prekey_public_key,
             signed_prekey_signature = EXCLUDED.signed_prekey_signature,
             updated_at = CURRENT_TIMESTAMP`,
        [address, identityPublicKey, signedPrekey.id, signedPrekey.publicKey, signedPrekey.signature]
      );

      for (const otp of oneTimePrekeys) {
        await client.query(
          `INSERT INTO e2ee_one_time_prekeys (address, key_id, one_time_public_key)
           VALUES ($1, $2, $3)
           ON CONFLICT (address, key_id) DO NOTHING`,
          [address, otp.id, otp.publicKey]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function fetchPrekeyBundle(
  address: string,
  pool?: Pool
): Promise<E2EEPrekeyBundle | null> {
  // Check memory store
  const identity = memoryIdentityKeys.get(address);
  let oneTimePrekey: { id: number; publicKey: string } | undefined;

  const otps = memoryOneTimePrekeys.get(address);
  if (otps && otps.length > 0) {
    const popped = otps.shift();
    if (popped) {
      oneTimePrekey = { id: popped.keyId, publicKey: popped.publicKey };
    }
  }

  // If found in memory, return bundle
  if (identity) {
    const bundle: E2EEPrekeyBundle = {
      address: identity.address,
      identityPublicKey: identity.identityPublicKey,
      signedPrekey: {
        id: identity.signedPrekeyId,
        publicKey: identity.signedPrekeyPublicKey,
        signature: identity.signedPrekeySignature,
      },
      oneTimePrekey,
    };

    // Also remove consumed OTP from DB if pool is available
    if (pool && oneTimePrekey) {
      pool.query(`DELETE FROM e2ee_one_time_prekeys WHERE address = $1 AND key_id = $2`, [
        address,
        oneTimePrekey.id,
      ]).catch(() => {});
    }

    return bundle;
  }

  // Fallback to Postgres query if memory was empty
  if (pool) {
    try {
      const res = await pool.query(
        `SELECT address, identity_public_key, signed_prekey_id, signed_prekey_public_key, signed_prekey_signature
         FROM e2ee_identity_keys WHERE address = $1`,
        [address]
      );
      if (res.rows.length === 0) return null;
      const row = res.rows[0];

      // Pop one-time prekey
      const otpRes = await pool.query(
        `DELETE FROM e2ee_one_time_prekeys
         WHERE ctid IN (
           SELECT ctid FROM e2ee_one_time_prekeys
           WHERE address = $1
           LIMIT 1
         )
         RETURNING key_id, one_time_public_key`,
        [address]
      );

      let fetchedOTP: { id: number; publicKey: string } | undefined;
      if (otpRes.rows.length > 0) {
        fetchedOTP = {
          id: otpRes.rows[0].key_id,
          publicKey: otpRes.rows[0].one_time_public_key,
        };
      }

      return {
        address: row.address,
        identityPublicKey: row.identity_public_key,
        signedPrekey: {
          id: row.signed_prekey_id,
          publicKey: row.signed_prekey_public_key,
          signature: row.signed_prekey_signature,
        },
        oneTimePrekey: fetchedOTP,
      };
    } catch {
      return null;
    }
  }

  return null;
}

export function clearPrekeyVault(): void {
  memoryIdentityKeys.clear();
  memoryOneTimePrekeys.clear();
}
