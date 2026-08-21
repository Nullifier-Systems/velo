# Decentralized Jury Dispute Arbitration & Escrow Staking/Slashing Protocol

## Overview

This document describes the decentralized jury dispute arbitration system and escrow staking/slashing protocol implemented in the Velo escrow contract. This system extends the existing single-arbitrator model with a multi-juror selection mechanism, voting-based dispute resolution, and economic incentives through staking, slashing, and rewards.

## Key Features

- **Multi-Juror Selection**: Random selection of multiple jurors from the arbitrator pool for each dispute
- **Decentralized Voting**: Jurors vote on dispute outcomes with majority decision determining fund distribution
- **Staking Mechanism**: Arbitrators must stake tokens to participate in the jury pool
- **Slashing Protocol**: Economic penalties for inactivity and malicious voting behavior
- **Reward Distribution**: Incentives for honest jurors who vote with the majority
- **Reputation Tracking**: Comprehensive tracking of arbitrator performance and behavior
- **Configurable Parameters**: Admin-configurable jury size, voting windows, and slashing rates

## Architecture

### Data Structures

#### JuryState
```rust
pub struct JuryState {
    pub jurors: Vec<Address>,           // Selected jurors for this dispute
    pub votes: Vec<JuryVote>,           // Cast votes
    pub voting_deadline: u32,           // Ledger when voting closes
    pub total_stake_at_selection: i128, // Total stake of selected jurors
}
```

#### JuryVote
```rust
pub struct JuryVote {
    pub juror: Address,           // Juror who cast the vote
    pub vote_for_buyer: bool,      // true = buyer wins, false = seller wins
    pub voted_at_ledger: u32,      // When the vote was cast
}
```

#### Enhanced ArbitratorMeta
```rust
pub struct ArbitratorMeta {
    pub joined_ledger: u32,        // When this membership period began
    pub active: bool,              // Whether currently in the pool
    pub pending_disputes: u32,     // Currently assigned disputes
    pub total_resolved: u32,       // Total disputes resolved
    pub honest_votes: u32,         // Votes with majority
    pub dissenting_votes: u32,     // Votes against majority
    pub total_slashed: i128,       // Total stake slashed
    pub total_rewards: i128,       // Total rewards earned
    pub last_activity_ledger: u32, // Last activity timestamp
}
```

#### SlashingConfig
```rust
pub struct SlashingConfig {
    pub inactivity_slash_bps: u32,        // Slash rate for inactivity (basis points)
    pub malicious_slash_bps: u32,          // Slash rate for malicious voting (basis points)
    pub inactivity_threshold_ledgers: u32, // Inactivity threshold
    pub honest_juror_reward_bps: u32,     // Reward rate for honest jurors (basis points)
}
```

## Workflow

### 1. Jury Selection

When a dispute is raised, the system selects a random jury from eligible arbitrators:

```rust
pub fn select_jury(env: Env, id: BytesN<32>) -> Result<Vec<Address>, Error>
```

**Process:**
1. Retrieves eligible arbitrators from the dispute selection snapshot
2. Validates jury size configuration (default: 5 jurors, min: 3, max: 11)
3. Ensures sufficient eligible arbitrators exist
4. Uses Fisher-Yates shuffle with PRNG for random selection
5. Creates `JuryState` with selected jurors and voting deadline
6. Increments pending disputes for each selected juror
7. Calculates total stake of selected jurors

**Security Features:**
- Random selection using Soroban's PRNG (seeded by transaction-set hash)
- Eligibility snapshot taken at dispute time (prevents gaming)
- One-time selection (cannot be redone)
- Activation delay prevents last-minute joins

### 2. Juror Voting

Selected jurors cast their votes during the voting window:

```rust
pub fn cast_vote(env: Env, id: BytesN<32>, juror: Address, vote_for_buyer: bool) -> Result<(), Error>
```

**Process:**
1. Verifies caller is a selected juror
2. Checks juror hasn't already voted
3. Validates voting window is open
4. Records vote with timestamp
5. Updates juror's last activity timestamp

**Voting Window:**
- Default: 24 hours (configurable)
- Minimum: 30 seconds
- Votes outside window are rejected

### 3. Dispute Resolution

After the voting deadline, anyone can resolve the dispute:

```rust
pub fn resolve_by_jury(env: Env, id: BytesN<32>) -> Result<(), Error>
```

**Process:**
1. Validates voting deadline has passed
2. Ensures minimum participation (2/3 of jurors must vote)
3. Tallies votes (buyer vs seller)
4. Determines majority decision
5. Applies slashing to dissenting jurors
6. Distributes rewards to honest jurors
7. Resolves trade based on majority decision
8. Cleans up jury state

**Majority Decision:**
- Buyer wins: Full refund to buyer (10_000 bps)
- Seller wins: Full payment to seller minus fee (0 bps)

### 4. Slashing Mechanism

#### Inactivity Slashing

Jurors who don't participate for extended periods are slashed:

```rust
pub fn apply_inactivity_slashing(env: Env, arbitrator: Address) -> Result<(), Error>
```

**Process:**
1. Checks arbitrator is active in the pool
2. Validates inactivity threshold has passed
3. Calculates slash amount (default: 10% of stake)
4. Transfers slashed amount to admin
5. Updates arbitrator metadata

**Default Threshold:** 7 days of inactivity

#### Malicious Voting Slashing

Jurors who vote against the majority are slashed during dispute resolution:

- Slash rate: Configurable (default: 50% of stake)
- Applied automatically during `resolve_by_jury()`
- Slashed amount transferred to admin

### 5. Reward Distribution

Jurors who vote with the majority receive rewards:

**Reward Calculation:**
```rust
reward = (dispute_amount * honest_juror_reward_bps) / 10_000
```

**Default Reward Rate:** 1% of dispute amount

**Process:**
1. Calculated per honest juror during resolution
2. Added to juror's stake
3. Tracked in `total_rewards` metadata
4. Transferred from contract to juror

## Configuration

### Jury Size

```rust
pub fn set_jury_size(env: Env, size: u32, signers: Vec<Address>) -> Result<(), Error>
```

- **Minimum:** 3 jurors
- **Maximum:** 11 jurors
- **Default:** 5 jurors
- **Requires:** Admin or multisig authorization

### Voting Window

```rust
pub fn set_voting_window(env: Env, ledgers: u32, signers: Vec<Address>) -> Result<(), Error>
```

- **Minimum:** 6 ledgers (~30 seconds)
- **Default:** 17,280 ledgers (~24 hours)
- **Requires:** Admin or multisig authorization

### Slashing Configuration

```rust
pub fn set_slashing_config(env: Env, config: SlashingConfig, signers: Vec<Address>) -> Result<(), Error>
```

**Default Parameters:**
- `inactivity_slash_bps`: 1000 (10%)
- `malicious_slash_bps`: 5000 (50%)
- `inactivity_threshold_ledgers`: 362,880 (~7 days)
- `honest_juror_reward_bps`: 100 (1%)

**Requires:** Admin or multisig authorization

## Security Considerations

### Randomness

- Uses Soroban's `env.prng()` for jury selection
- Seed derived from transaction-set hash (consensus value)
- Selection happens in separate transaction from dispute raising
- One-time selection prevents rerolling

### Sybil Resistance

- Activation delay (1 day) prevents last-minute joins
- Staking requirement increases Sybil cost
- Reputation tracking identifies patterns
- Slashing discourages malicious behavior

### Collusion Resistance

- Jury size > 1 prevents single-point failure
- Random selection unpredictable
- Majority decision requires coordination
- Slashing penalizes coordinated malicious voting

### Economic Security

- Staking ensures skin in the game
- Slashing creates economic disincentive for bad behavior
- Rewards incentivize honest participation
- Inactivity slashing ensures ongoing engagement

## Integration with Existing System

### Backward Compatibility

- Existing single-arbitrator system remains functional
- Jury system is opt-in via `select_jury()`
- Fallback to single arbitrator when pool is empty
- Original `resolve_dispute()` still works

### Storage Layout

- New `DataKey` variants for jury system
- Enhanced `ArbitratorMeta` with additional fields
- Separate `JuryState` per dispute
- `SlashingConfig` in instance storage

### Event Emissions

- `jury_selected`: Emitted when jury is selected
- `vote_cast`: Emitted when a juror votes
- `jury_resolved`: Emitted when dispute is resolved by jury
- `inactivity_slash`: Emitted when inactivity slashing occurs

## API Endpoints

The following contract functions are available for integration:

### Jury Management
- `select_jury(id)` - Select jury for disputed trade
- `cast_vote(id, juror, vote_for_buyer)` - Cast vote on dispute
- `resolve_by_jury(id)` - Resolve dispute by jury vote
- `get_jury_state(id)` - Get jury state for dispute

### Configuration
- `set_jury_size(size, signers)` - Set jury size
- `set_voting_window(ledgers, signers)` - Set voting window
- `set_slashing_config(config, signers)` - Set slashing parameters
- `get_jury_size_config()` - Get current jury size
- `get_voting_window_config()` - Get current voting window
- `get_slashing_config()` - Get current slashing config

### Slashing
- `apply_inactivity_slashing(arbitrator)` - Apply inactivity slash
- `stake_arbitrator(arbitrator, amount)` - Stake tokens for arbitration

### Read Accessors
- `get_arbitrator(arbitrator)` - Get arbitrator metadata
- `get_dispute_selection(id)` - Get dispute selection state

## Testing

Comprehensive tests are available in `contracts/escrow/src/jury_test.rs`:

- Jury selection with sufficient arbitrators
- Jury selection failure with insufficient arbitrators
- Vote casting by jurors
- Vote rejection for non-jurors
- Duplicate vote prevention
- Slashing configuration
- Jury size configuration
- Voting window configuration

Run tests with:
```bash
cd contracts
cargo test -p escrow jury_test
```

## Future Enhancements

Potential improvements for future versions:

1. **Weighted Voting**: Juror voting power proportional to stake
2. **Appeal Process**: Multi-stage jury system for appeals
3. **Dynamic Jury Size**: Adjust jury size based on dispute amount
4. **Reputation-Based Selection**: Prefer high-reputation jurors
5. **Slashing Appeals**: Process for contesting unfair slashes
6. **Juror Anonymity**: Privacy-preserving juror identity
7. **Cross-Chain Juries**: Multi-chain juror participation

## References

- Main escrow contract: `contracts/escrow/src/lib.rs`
- Jury tests: `contracts/escrow/src/jury_test.rs`
- Arbitrator pool selection: `docs/arbitrator-pool-selection.md`
- Dispute handling: `docs/stuck-trades.md`
- Dispute evidence: `docs/dispute-evidence.md`
