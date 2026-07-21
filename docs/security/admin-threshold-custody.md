# Threshold Custody for Platform Admin Authority

Issue #215. The escrow contract's admin address controls real economic
authority: it is the fee recipient, it can change the platform fee, pause the
contract, rotate signers, and resolve disputed trades (moving escrowed funds).
Under a single key, one compromise or loss hands an attacker all of that. This
document describes the N-of-M custody model, why it is sound, and the
key-generation and recovery ceremonies.

## Model: N-of-M quorum enforced on-chain

The contract stores a `Signers` set and a `Threshold`. Every privileged action
takes an explicit list of signers and passes it through `require_multisig`,
which:

1. requires at least `threshold` entries,
2. requires every entry to be a member of the stored signer set,
3. **requires every entry to be distinct**, and
4. calls `require_auth()` on each entry, so Stellar verifies a real signature
   from each holder.

Signature verification itself is delegated to Stellar's native `require_auth`
(audited protocol code) rather than any hand-rolled threshold cryptography. The
contract contributes only the quorum policy — membership, distinctness, and
count — which is what the tests below pin down.

Privileged actions covered: `set_platform_fee`, `set_fee_recipient`, `pause`,
`unpause`, `set_signers`, and `resolve` (dispute resolution).

### Why distinctness is the crux

A quorum check that only counts entries is **not** a quorum. Because
`require_auth()` on the same address succeeds every time it is called, a single
compromised holder could previously satisfy a 2-of-3 policy by submitting
`[k, k]` — the list is long enough and every entry is an authorized member. The
duplicate check is therefore the control that actually delivers "no single party
can act alone", and it is covered by
`multisig_rejects_a_single_key_repeated_to_meet_threshold`.

## Choosing M and N

- `N` (signer count) should be at least 3 so one key can be lost without
  freezing the platform.
- `threshold` should be a strict majority (2-of-3, 3-of-5). Never set
  `threshold = 1`: that is a single-key model with extra steps.
- The contract rejects `threshold = 0`, `threshold > N`, and an empty set.
- Holders must be **independent parties on independent hardware**. N keys in one
  password manager, or generated on one machine, is one key wearing a costume.

## Key-generation ceremony

Run once, before `migrate_to_multisig`.

1. **Select holders.** Choose N people/roles in different failure domains
   (different individuals, devices, and ideally locations).
2. **Generate independently.** Each holder generates their own Stellar keypair
   **on their own hardware**, offline where possible (hardware wallet preferred).
   No holder ever transmits a secret key; nobody generates on behalf of another.
3. **Publish public keys only.** Each holder shares only their `G...` address,
   over a channel where it can be verified out-of-band (read the address aloud
   or confirm a checksum) to defeat address substitution.
4. **Back up.** Each holder stores their seed offline (steel/paper), in a
   location the other holders do not control.
5. **Verify liveness before trusting the set.** Each holder signs a throwaway
   test transaction, proving they control the key and can actually sign, before
   it is entrusted with authority.
6. **Migrate.** The current single admin calls
   `migrate_to_multisig(signers, threshold)`. From this point every privileged
   action requires a distinct quorum.
7. **Verify the migration.** Confirm a lone key is now powerless: attempt a
   privileged call with one signer and with one signer repeated, and confirm
   both are rejected.

## Recovery ceremony (lost or compromised key)

Recovery is signer rotation, and it requires a quorum of the **remaining**
holders — which is why `N > threshold` matters.

1. **Declare the incident.** Treat a lost key and a compromised key the same:
   assume the attacker can sign.
2. **Assemble a quorum of unaffected holders** (`threshold` of them).
3. **Generate a replacement key** using the key-generation ceremony above.
4. **Rotate:** call `set_signers(new_signers, new_threshold, auth_signers)` with
   the quorum as `auth_signers`. The compromised key is excluded from
   `new_signers` and stops counting immediately.
5. **Verify:** confirm a quorum containing the rotated-out key is now rejected
   (covered by `signer_rotation_requires_a_quorum_and_enables_recovery`).
6. **Rotate the fee recipient too** if the compromised holder also controlled the
   payout address (`set_fee_recipient`).

> **Standing risk to accept explicitly:** if more than `N - threshold` keys are
> lost, authority is unrecoverable. For 2-of-3 that is two keys. Size N with the
> real-world reliability of your holders in mind.

## Alternative: a Stellar multisig account as the admin

Because `require_auth()` works on any address, the admin can instead be a
**Stellar account configured with its own signer weights and thresholds**. The
protocol then enforces the quorum at the transaction level and the contract
needs no signer list at all. This is attractive because it moves 100% of the
policy into audited protocol code.

The in-contract set is used here because it keeps the quorum, rotation, and the
audit trail on-chain and inspectable per action, and because it allows different
privileged actions to be reasoned about individually. The two are compatible: a
member of the signer set may itself be a multisig account.

## What we deliberately did not build

No hand-rolled threshold signature scheme (FROST/MPC). Implementing threshold
cryptography is a well-known source of subtle, high-severity bugs (nonce reuse,
biased nonces, rogue-key attacks), and it buys nothing here that a quorum over
native `require_auth` does not already provide.

## Tests

In `contracts/escrow/src/lib.rs` (`mod test`):

| Test                                                       | Property                                                     |
| :--------------------------------------------------------- | :----------------------------------------------------------- |
| `multisig_rejects_a_single_key_repeated_to_meet_threshold` | One compromised key cannot meet a quorum by repeating itself |
| `multisig_rejects_below_threshold`                         | Fewer than `threshold` signers is rejected                   |
| `multisig_rejects_an_unauthorized_signer`                  | Non-members do not count                                     |
| `multisig_accepts_distinct_threshold_signers`              | A real quorum succeeds                                       |
| `resolve_requires_a_quorum_once_multisig_is_active`        | Dispute resolution is not a single-key action                |
| `signer_rotation_requires_a_quorum_and_enables_recovery`   | Recovery works, and rotated-out keys stop counting           |
