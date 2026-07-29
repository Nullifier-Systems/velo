---------------------- MODULE HTLCAtomicityRelayerDowntime ----------------------
(***
 * TLA+ Specification of HTLC Atomic Swap Protocol (Stellar <-> EVM)
 * Step 3b: Relayer Downtime (Relayers stop / crash at arbitrary points)
 *
 * Actors: Chain A (EVM), Chain B (Stellar), Relayers (Threshold 2-of-3), Fault Model
 * Model:
 *  - Relayers can crash (go offline) at any point before or after Stellar release.
 *  - Offline relayers cannot submit attestations to EVM.
 ***)

EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS 
    Threshold,      \* e.g., 2
    TotalRelayers,  \* e.g., 3
    MaxTime         \* Bound on time steps

VARIABLES
    stellarState,   \* "UNINIT", "LOCKED", "RELEASED", "REFUNDED"
    evmState,       \* "UNINIT", "LOCKED", "WITHDRAWN", "REFUNDED"
    evmAttestations,\* Set of relayers that have successfully delivered attestation to EVM
    relayerSeen,    \* BOOLEAN: whether relayer network observed secret reveal on Stellar
    relayerOnline,  \* Function/Set: relayers currently online
    time,           \* Integer timestamp/ledger count [0..MaxTime]
    stellarTimeout, \* Time after which Stellar leg can refund
    evmTimeout      \* Time after which EVM leg can refund

vars == <<stellarState, evmState, evmAttestations, relayerSeen, relayerOnline, time, stellarTimeout, evmTimeout>>

Relayers == 1..TotalRelayers

(*** Initial States ***)
Init ==
    /\ stellarState = "UNINIT"
    /\ evmState = "UNINIT"
    /\ evmAttestations = {}
    /\ relayerSeen = FALSE
    /\ relayerOnline = Relayers
    /\ time = 0
    /\ stellarTimeout = 5
    /\ evmTimeout = 10

(*** Actions ***)

EVMLock ==
    /\ evmState = "UNINIT"
    /\ time < evmTimeout
    /\ evmState' = "LOCKED"
    /\ UNCHANGED <<stellarState, evmAttestations, relayerSeen, relayerOnline, time, stellarTimeout, evmTimeout>>

StellarLock ==
    /\ evmState = "LOCKED"
    /\ stellarState = "UNINIT"
    /\ time < stellarTimeout
    /\ stellarState' = "LOCKED"
    /\ UNCHANGED <<evmState, evmAttestations, relayerSeen, relayerOnline, time, stellarTimeout, evmTimeout>>

StellarRelease ==
    /\ stellarState = "LOCKED"
    /\ time < stellarTimeout
    /\ stellarState' = "RELEASED"
    /\ relayerSeen' = TRUE
    /\ UNCHANGED <<evmState, evmAttestations, relayerOnline, time, stellarTimeout, evmTimeout>>

\* Relayer crashes at an arbitrary point
RelayerCrash(r) ==
    /\ r \in relayerOnline
    /\ relayerOnline' = relayerOnline \ {r}
    /\ UNCHANGED <<stellarState, evmState, evmAttestations, relayerSeen, time, stellarTimeout, evmTimeout>>

\* Online relayer submits attestation
RelayerAttest(r) ==
    /\ relayerSeen = TRUE
    /\ r \in relayerOnline
    /\ evmState = "LOCKED"
    /\ r \notin evmAttestations
    /\ evmAttestations' = evmAttestations \cup {r}
    /\ IF Cardinality(evmAttestations \cup {r}) >= Threshold
       THEN evmState' = "WITHDRAWN"
       ELSE UNCHANGED evmState
    /\ UNCHANGED <<stellarState, relayerSeen, relayerOnline, time, stellarTimeout, evmTimeout>>

EVMRefund ==
    /\ evmState = "LOCKED"
    /\ time >= evmTimeout
    /\ evmState' = "REFUNDED"
    /\ UNCHANGED <<stellarState, evmAttestations, relayerSeen, relayerOnline, time, stellarTimeout, evmTimeout>>

StellarRefund ==
    /\ stellarState = "LOCKED"
    /\ time >= stellarTimeout
    /\ stellarState' = "REFUNDED"
    /\ UNCHANGED <<stellarState, evmAttestations, relayerSeen, relayerOnline, time, stellarTimeout, evmTimeout>>

Tick ==
    /\ time < MaxTime
    /\ time' = time + 1
    /\ UNCHANGED <<stellarState, evmState, evmAttestations, relayerSeen, relayerOnline, stellarTimeout, evmTimeout>>

(*** Next State Relation ***)
Next ==
    \/ EVMLock
    \/ StellarLock
    \/ StellarRelease
    \/ \E r \in Relayers : RelayerCrash(r)
    \/ \E r \in Relayers : RelayerAttest(r)
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
