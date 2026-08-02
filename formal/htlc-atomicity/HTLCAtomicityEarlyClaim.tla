---------------------- MODULE HTLCAtomicityEarlyClaim ----------------------
(***
 * TLA+ Specification of HTLC Atomic Swap Protocol (Stellar <-> EVM)
 * Step 3c: Malicious Relayer Attempting Early Claim
 *
 * Actors: Chain A (EVM), Chain B (Stellar), Relayers, Malicious Relayers
 * Model:
 *  - Malicious relayers submit attestations early (before secret reveal on Stellar,
 *    or before Stellar leg is locked, or with guessed/leaked/invalid preimages).
 *  - EVM HTLC contract checks `swaps[hashlock].exists`, but has no direct cross-chain
 *    state verification of Stellar leg lock status.
 ***)

EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS 
    Threshold,          \* e.g., 2
    TotalRelayers,      \* e.g., 3
    MaliciousRelayers,  \* Set of malicious relayer IDs
    MaxTime             \* Bound on time steps

VARIABLES
    stellarState,   \* "UNINIT", "LOCKED", "RELEASED", "REFUNDED"
    evmState,       \* "UNINIT", "LOCKED", "WITHDRAWN", "REFUNDED"
    evmAttestations,\* Set of relayers that have submitted attestation to EVM
    relayerSeen,    \* BOOLEAN: whether secret was legitimately revealed on Stellar
    time,           \* Integer timestamp/ledger count [0..MaxTime]
    stellarTimeout, \* Time after which Stellar leg can refund
    evmTimeout      \* Time after which EVM leg can refund

vars == <<stellarState, evmState, evmAttestations, relayerSeen, time, stellarTimeout, evmTimeout>>

Relayers == 1..TotalRelayers

(*** Initial States ***)
Init ==
    /\ stellarState = "UNINIT"
    /\ evmState = "UNINIT"
    /\ evmAttestations = {}
    /\ relayerSeen = FALSE
    /\ time = 0
    /\ stellarTimeout = 5
    /\ evmTimeout = 10

(*** Actions ***)

EVMLock ==
    /\ evmState = "UNINIT"
    /\ time < evmTimeout
    /\ evmState' = "LOCKED"
    /\ UNCHANGED <<stellarState, evmAttestations, relayerSeen, time, stellarTimeout, evmTimeout>>

StellarLock ==
    /\ evmState = "LOCKED"
    /\ stellarState = "UNINIT"
    /\ time < stellarTimeout
    /\ stellarState' = "LOCKED"
    /\ UNCHANGED <<evmState, evmAttestations, relayerSeen, time, stellarTimeout, evmTimeout>>

StellarRelease ==
    /\ stellarState = "LOCKED"
    /\ time < stellarTimeout
    /\ stellarState' = "RELEASED"
    /\ relayerSeen' = TRUE
    /\ UNCHANGED <<evmState, evmAttestations, time, stellarTimeout, evmTimeout>>

\* Honest Relayer attestation (only after legitimate Stellar release)
HonestRelayerAttest(r) ==
    /\ r \in (Relayers \ MaliciousRelayers)
    /\ relayerSeen = TRUE
    /\ evmState = "LOCKED"
    /\ r \notin evmAttestations
    /\ evmAttestations' = evmAttestations \cup {r}
    /\ IF Cardinality(evmAttestations \cup {r}) >= Threshold
       THEN evmState' = "WITHDRAWN"
       ELSE UNCHANGED evmState
    /\ UNCHANGED <<stellarState, relayerSeen, time, stellarTimeout, evmTimeout>>

\* Malicious Relayer Early Claim Attempt (submits attestation before legitimate Stellar release)
MaliciousEarlyAttest(r) ==
    /\ r \in MaliciousRelayers
    /\ evmState = "LOCKED"
    /\ r \notin evmAttestations
    /\ evmAttestations' = evmAttestations \cup {r}
    /\ IF Cardinality(evmAttestations \cup {r}) >= Threshold
       THEN evmState' = "WITHDRAWN"
       ELSE UNCHANGED evmState
    /\ UNCHANGED <<stellarState, relayerSeen, time, stellarTimeout, evmTimeout>>

EVMRefund ==
    /\ evmState = "LOCKED"
    /\ time >= evmTimeout
    /\ evmState' = "REFUNDED"
    /\ UNCHANGED <<stellarState, evmAttestations, relayerSeen, time, stellarTimeout, evmTimeout>>

StellarRefund ==
    /\ stellarState = "LOCKED"
    /\ time >= stellarTimeout
    /\ stellarState' = "REFUNDED"
    /\ UNCHANGED <<stellarState, evmAttestations, relayerSeen, time, stellarTimeout, evmTimeout>>

Tick ==
    /\ time < MaxTime
    /\ time' = time + 1
    /\ UNCHANGED <<stellarState, evmState, evmAttestations, relayerSeen, stellarTimeout, evmTimeout>>

(*** Next State Relation ***)
Next ==
    \/ EVMLock
    \/ StellarLock
    \/ StellarRelease
    \/ \E r \in (Relayers \ MaliciousRelayers) : HonestRelayerAttest(r)
    \/ \E r \in MaliciousRelayers : MaliciousEarlyAttest(r)
    \/ EVMRefund
    \/ StellarRefund
    \/ Tick

Spec == Init /\ [][Next]_vars

(*** Safety Property: Atomicity & Unauthorized Extraction ***)
AtomicityViolation ==
    \/ (stellarState = "RELEASED" /\ evmState = "REFUNDED")
    \/ (evmState = "WITHDRAWN" /\ stellarState = "REFUNDED")
    \/ (evmState = "WITHDRAWN" /\ stellarState = "UNINIT")

Atomicity == ~AtomicityViolation

=============================================================================
