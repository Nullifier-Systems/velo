---------------------- MODULE HTLCAtomicityCensorship ----------------------
(***
 * TLA+ Specification of HTLC Atomic Swap Protocol (Stellar <-> EVM)
 * Step 3d: Malicious Relayer Refusing to Relay (Selective Censorship)
 *
 * Actors: Chain A (EVM), Chain B (Stellar), Relayers, Censoring Relayers
 * Model:
 *  - Censoring relayers selectively refuse to attest to legitimate secret reveals.
 *  - Honest relayers observe and submit attestations.
 *  - Evaluates threshold quorum M when censoring set c >= N - M + 1.
 ***)

EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS 
    Threshold,          \* e.g., 2
    TotalRelayers,      \* e.g., 3
    CensoringRelayers,  \* Set of censoring relayer IDs
    MaxTime             \* Bound on time steps

VARIABLES
    stellarState,   \* "UNINIT", "LOCKED", "RELEASED", "REFUNDED"
    evmState,       \* "UNINIT", "LOCKED", "WITHDRAWN", "REFUNDED"
    evmAttestations,\* Set of relayers that have submitted attestation to EVM
    relayerSeen,    \* BOOLEAN: whether secret reveal occurred on Stellar
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

\* Honest relayer attestation
HonestRelayerAttest(r) ==
    /\ r \in (Relayers \ CensoringRelayers)
    /\ relayerSeen = TRUE
    /\ evmState = "LOCKED"
    /\ r \notin evmAttestations
    /\ evmAttestations' = evmAttestations \cup {r}
    /\ IF Cardinality(evmAttestations \cup {r}) >= Threshold
       THEN evmState' = "WITHDRAWN"
       ELSE UNCHANGED evmState
    /\ UNCHANGED <<stellarState, relayerSeen, time, stellarTimeout, evmTimeout>>

\* Censoring relayer explicitly withholds attestation (no change to evmAttestations)
CensoringRelayerWithhold(r) ==
    /\ r \in CensoringRelayers
    /\ relayerSeen = TRUE
    /\ UNCHANGED <<stellarState, evmState, evmAttestations, relayerSeen, time, stellarTimeout, evmTimeout>>

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
    \/ \E r \in (Relayers \ CensoringRelayers) : HonestRelayerAttest(r)
    \/ \E r \in CensoringRelayers : CensoringRelayerWithhold(r)
    \/ EVMRefund
    \/ StellarRefund
    \/ Tick

Spec == Init /\ [][Next]_vars

(*** Safety Property: Atomicity ***)
AtomicityViolation ==
    \/ (stellarState = "RELEASED" /\ evmState = "REFUNDED")
    \/ (evmState = "WITHDRAWN" /\ stellarState = "REFUNDED")

Atomicity == ~AtomicityViolation

=============================================================================
