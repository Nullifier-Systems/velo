---------------------- MODULE HTLCAtomicityNetworkDelay ----------------------
(***
 * TLA+ Specification of HTLC Atomic Swap Protocol (Stellar <-> EVM)
 * Step 3a: Message Delay / Network Asynchrony Only
 *
 * Actors: Chain A (EVM), Chain B (Stellar), Relayers (Threshold 2-of-3), Network Delay
 * Model:
 *  - Relayers are honest and eventually attempt delivery.
 *  - Network introduces arbitrary delay on attestation delivery to EVM.
 *  - Time can advance past timelocks while attestations are in transit.
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

\* Relayer attestation arrives on EVM after arbitrary network delay
RelayerAttest(r) ==
    /\ relayerSeen = TRUE
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

\* Time step can tick freely regardless of pending relayers (simulating network delay)
Tick ==
    /\ time < MaxTime
    /\ time' = time + 1
    /\ UNCHANGED <<stellarState, evmState, evmAttestations, relayerSeen, stellarTimeout, evmTimeout>>

(*** Next State Relation ***)
Next ==
    \/ EVMLock
    \/ StellarLock
    \/ StellarRelease
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
