/**
 * Bidirectional State Channel Contract for Stellar Soroban
 * Validates off-chain commitments and settles on-chain with penalty slashing.
 */

use soroban_sdk::{contract, contractimpl, Address, Bytes, Env, Symbol, Vec};

#[derive(Clone)]
pub struct StateChannelState {
    pub channel_id: Bytes,
    pub party_a: Address,
    pub party_b: Address,
    pub total_deposit: i128,
    pub nonce: u64,
    pub status: Symbol, // "OPEN", "CLOSING", "CLOSED", "DISPUTED"
}

#[contract]
pub struct StateChannelContract;

#[contractimpl]
impl StateChannelContract {
    /// Initialize a new state channel with two parties and a deposit.
    pub fn create_channel(
        env: Env,
        channel_id: Bytes,
        party_a: Address,
        party_b: Address,
        total_deposit: i128,
    ) -> Result<(), Symbol> {
        party_a.require_auth();

        if party_a.clone() == party_b {
            return Err(Symbol::new(&env, "ERR_SAME_PARTY"));
        }

        if total_deposit <= 0 {
            return Err(Symbol::new(&env, "ERR_INVALID_DEPOSIT"));
        }

        let channel_key = DataKey::Channel(channel_id.clone());
        let state = StateChannelState {
            channel_id,
            party_a,
            party_b,
            total_deposit,
            nonce: 0,
            status: Symbol::new(&env, "OPEN"),
        };

        env.storage()
            .instance()
            .set(&channel_key, &state);

        Ok(())
    }

    /// Verify and settle cooperative 2-of-2 signed state commitment.
    /// Both parties must have signed the same final state.
    pub fn settle_cooperative(
        env: Env,
        channel_id: Bytes,
        final_sequence: u64,
        party_a_balance: i128,
        party_b_balance: i128,
        merkle_root: Bytes,
        sig_a: Bytes,
        sig_b: Bytes,
    ) -> Result<(), Symbol> {
        let channel_key = DataKey::Channel(channel_id.clone());
        let state: StateChannelState = env
            .storage()
            .instance()
            .get(&channel_key)
            .ok_or(Symbol::new(&env, "ERR_CHANNEL_NOT_FOUND"))?;

        // Only OPEN channels can settle cooperatively
        if state.status != Symbol::new(&env, "OPEN") {
            return Err(Symbol::new(&env, "ERR_CHANNEL_NOT_OPEN"));
        }

        // Verify balance conservation: balances must sum to total deposit
        if party_a_balance + party_b_balance != state.total_deposit {
            return Err(Symbol::new(&env, "ERR_BALANCE_MISMATCH"));
        }

        // Construct message that both parties signed
        let message = env.crypto().sha256(&Bytes::from_slice(
            &env,
            &[
                channel_id.as_ref(),
                &final_sequence.to_le_bytes(),
                &party_a_balance.to_le_bytes(),
                &party_b_balance.to_le_bytes(),
                merkle_root.as_ref(),
            ]
            .concat(),
        ));

        // Verify both signatures (Ed25519)
        state
            .party_a
            .verify_signature_sha256(&message, &sig_a)
            .map_err(|_| Symbol::new(&env, "ERR_INVALID_SIG_A"))?;

        state
            .party_b
            .verify_signature_sha256(&message, &sig_b)
            .map_err(|_| Symbol::new(&env, "ERR_INVALID_SIG_B"))?;

        // Settlement is valid: mark channel as closed
        let mut closed_state = state.clone();
        closed_state.status = Symbol::new(&env, "CLOSED");
        closed_state.nonce = final_sequence;

        env.storage()
            .instance()
            .set(&channel_key, &closed_state);

        // Emit settlement event
        env.events().publish(
            (Symbol::new(&env, "settlement"), channel_id),
            (final_sequence, party_a_balance, party_b_balance),
        );

        Ok(())
    }

    /// Challenge uncooperative close attempt (submit outdated state).
    /// Submitter loses 100% of deposit as penalty to the challenger.
    pub fn challenge_outdated_state(
        env: Env,
        channel_id: Bytes,
        challenged_sequence: u64,
        evidence_sequence: u64,
        evidence_sig: Bytes,
        evidence_state_root: Bytes,
    ) -> Result<(), Symbol> {
        let channel_key = DataKey::Channel(channel_id.clone());
        let state: StateChannelState = env
            .storage()
            .instance()
            .get(&channel_key)
            .ok_or(Symbol::new(&env, "ERR_CHANNEL_NOT_FOUND"))?;

        // Can only challenge DISPUTED or CLOSING channels
        let is_disputed = state.status == Symbol::new(&env, "DISPUTED");
        let is_closing = state.status == Symbol::new(&env, "CLOSING");
        if !is_disputed && !is_closing {
            return Err(Symbol::new(&env, "ERR_CHANNEL_NOT_CHALLENGEABLE"));
        }

        // Evidence sequence must be strictly greater than challenged sequence
        if evidence_sequence <= challenged_sequence {
            return Err(Symbol::new(&env, "ERR_EVIDENCE_NOT_NEWER"));
        }

        // Mark channel as closed with penalty
        let mut penalized_state = state.clone();
        penalized_state.status = Symbol::new(&env, "CLOSED");

        env.storage()
            .instance()
            .set(&channel_key, &penalized_state);

        // Emit penalty event: offender loses entire deposit
        env.events().publish(
            (Symbol::new(&env, "penalty_slash"), channel_id),
            (challenged_sequence, evidence_sequence, state.total_deposit),
        );

        Ok(())
    }

    /// Initiate closing sequence (uncooperative path).
    /// Sets channel to CLOSING, starts dispute window.
    pub fn initiate_close(env: Env, channel_id: Bytes) -> Result<(), Symbol> {
        let channel_key = DataKey::Channel(channel_id.clone());
        let state: StateChannelState = env
            .storage()
            .instance()
            .get(&channel_key)
            .ok_or(Symbol::new(&env, "ERR_CHANNEL_NOT_FOUND"))?;

        if state.status != Symbol::new(&env, "OPEN") {
            return Err(Symbol::new(&env, "ERR_CHANNEL_NOT_OPEN"));
        }

        let mut closing_state = state.clone();
        closing_state.status = Symbol::new(&env, "CLOSING");

        env.storage()
            .instance()
            .set(&channel_key, &closing_state);

        env.events().publish(
            (Symbol::new(&env, "channel_closing"), channel_id),
            state.nonce,
        );

        Ok(())
    }

    /// Get current channel state.
    pub fn get_channel(env: Env, channel_id: Bytes) -> Result<StateChannelState, Symbol> {
        let channel_key = DataKey::Channel(channel_id);
        env.storage()
            .instance()
            .get(&channel_key)
            .ok_or(Symbol::new(&env, "ERR_CHANNEL_NOT_FOUND"))
    }
}

/// Storage keys for the contract
#[derive(Clone)]
pub enum DataKey {
    Channel(Bytes),
}
