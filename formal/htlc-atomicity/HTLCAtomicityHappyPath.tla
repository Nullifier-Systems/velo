---------------------- MODULE HTLCAtomicityHappyPath ----------------------
(***
 * TLA+ Specification of HTLC Atomic Swap Protocol (Stellar <-> EVM)
 * Step 2: Happy Path Model (Cooperative, non-adversarial flow)
 *
 * Actors: Chain A (EVM), Chain B (Stellar), Relayers (Threshold 2-of-3)
 * Assumptions:
 *  - Both parties act honestly.
 *  - Relayers are live, honest, and operate without network delay.
 *  - EVM Timelock > Stellar Timelock (correct HTLC timelock hierarchy).
 ***)

EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS 
    Threshold,      \* e.g., 2
    TotalRelayers,  \* e.g., 3
    MaxTime         \* Bound on time steps

VARIABLES
    stellarState,   \* "UNINIT", "LOCKED", "RELEASED", "REFUNDED"
    evmState,       \* "UNINIT", "LOCKED", "WITHDRAWN", "REFUNDED"
    evmAttestations,\* Set of relayers that have submitted attestation to EVM
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

\* Buyer locks funds on EVM leg first
EVMLock ==
    /\ evmState = "UNINIT"
    /\ time < evmTimeout
    /\ evmState' = "LOCKED"
    /\ UNCHANGED <<stellarState, evmAttestations, relayerSeen, time, stellarTimeout, evmTimeout>>

\* Seller locks funds on Stellar after observing EVM lock
StellarLock ==
    /\ evmState = "LOCKED"
    /\ stellarState = "UNINIT"
    /\ time < stellarTimeout
    /\ stellarState' = "LOCKED"
    /\ UNCHANGED <<evmState, evmAttestations, relayerSeen, time, stellarTimeout, evmTimeout>>

\* Buyer reveals secret on Stellar to claim funds
StellarRelease ==
    /\ stellarState = "LOCKED"
    /\ time < stellarTimeout
    /\ stellarState' = "RELEASED"
    /\ relayerSeen' = TRUE
    /\ UNCHANGED <<evmState, evmAttestations, time, stellarTimeout, evmTimeout>>

\* Relayers observe Stellar reveal and submit attestations to EVM
RelayerAttest(r) ==
    /\ relayerSeen = TRUE
    /\ evmState = "LOCKED"
    /\ r \notin evmAttestations
    /\ evmAttestations' = evmAttestations \cup {r}
    /\ IF Cardinality(evmAttestations \cup {r}) >= Threshold
       THEN evmState' = "WITHDRAWN"
       ELSE UNCHANGED evmState
    /\ UNCHANGED <<stellarState, relayerSeen, time, stellarTimeout, evmTimeout>>

\* EVM Refund action (after timelock)
EVMRefund ==
    /\ evmState = "LOCKED"
    /\ time >= evmTimeout
    /\ evmState' = "REFUNDED"
    /\ UNCHANGED <<stellarState, evmAttestations, relayerSeen, time, stellarTimeout, evmTimeout>>

\* Stellar Refund action (after timelock)
StellarRefund ==
    /\ stellarState = "LOCKED"
    /\ time >= stellarTimeout
    /\ stellarState' = "REFUNDED"
    /\ UNCHANGED <<evmState, evmAttestations, relayerSeen, time, stellarTimeout, evmTimeout>>

\* Time step forward (in happy path, pending relayers attest before time expires)
Tick ==
    /\ time < MaxTime
    /\ ~(relayerSeen /\ evmState = "LOCKED" /\ Cardinality(evmAttestations) < Threshold)
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
