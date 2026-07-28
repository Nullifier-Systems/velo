"""
Pure Python Model Checker for HTLC Atomicity Specification
Simulates state space exploration identical to TLC model checker.
"""
from dataclasses import dataclass
from typing import Set, Tuple, List, Dict

Threshold = 2
TotalRelayers = 3
MaxTime = 6
Relayers = {1, 2, 3}

@dataclass(frozen=True)
class State:
    stellar_state: str   # UNINIT, LOCKED, RELEASED, REFUNDED
    evm_state: str       # UNINIT, LOCKED, WITHDRAWN, REFUNDED
    evm_attestations: Tuple[int, ...]
    relayer_seen: bool
    time: int
    stellar_timeout: int
    evm_timeout: int

    def atomicity_violation(self) -> bool:
        return (
            (self.stellar_state == "RELEASED" and self.evm_state == "REFUNDED") or
            (self.evm_state == "WITHDRAWN" and self.stellar_state == "REFUNDED")
        )

def initial_state() -> State:
    return State(
        stellar_state="UNINIT",
        evm_state="UNINIT",
        evm_attestations=(),
        relayer_seen=False,
        time=0,
        stellar_timeout=5,
        evm_timeout=3
    )

def get_next_states(s: State) -> List[Tuple[str, State]]:
    next_states = []

    # EVMLock
    if s.evm_state == "UNINIT" and s.time < s.evm_timeout:
        next_states.append(("EVMLock", State(
            s.stellar_state, "LOCKED", s.evm_attestations, s.relayer_seen, s.time, s.stellar_timeout, s.evm_timeout
        )))

    # StellarLock
    if s.evm_state == "LOCKED" and s.stellar_state == "UNINIT" and s.time < s.stellar_timeout:
        next_states.append(("StellarLock", State(
            "LOCKED", s.evm_state, s.evm_attestations, s.relayer_seen, s.time, s.stellar_timeout, s.evm_timeout
        )))

    # StellarRelease
    if s.stellar_state == "LOCKED" and s.time < s.stellar_timeout:
        next_states.append(("StellarRelease", State(
            "RELEASED", s.evm_state, s.evm_attestations, True, s.time, s.stellar_timeout, s.evm_timeout
        )))

    # RelayerAttest(r)
    if s.relayer_seen and s.evm_state == "LOCKED":
        for r in Relayers:
            if r not in s.evm_attestations:
                new_att = tuple(sorted(list(s.evm_attestations) + [r]))
                new_evm = "WITHDRAWN" if len(new_att) >= Threshold else s.evm_state
                next_states.append((f"RelayerAttest({r})", State(
                    s.stellar_state, new_evm, new_att, s.relayer_seen, s.time, s.stellar_timeout, s.evm_timeout
                )))

    # EVMRefund
    if s.evm_state == "LOCKED" and s.time >= s.evm_timeout:
        next_states.append(("EVMRefund", State(
            s.stellar_state, "REFUNDED", s.evm_attestations, s.relayer_seen, s.time, s.stellar_timeout, s.evm_timeout
        )))

    # StellarRefund
    if s.stellar_state == "LOCKED" and s.time >= s.stellar_timeout:
        next_states.append(("StellarRefund", State(
            "REFUNDED", s.evm_state, s.evm_attestations, s.relayer_seen, s.time, s.stellar_timeout, s.evm_timeout
        )))

    # Tick
    if s.time < MaxTime:
        next_states.append(("Tick", State(
            s.stellar_state, s.evm_state, s.evm_attestations, s.relayer_seen, s.time + 1, s.stellar_timeout, s.evm_timeout
        )))

    return next_states

def model_check():
    start = initial_state()
    visited: Set[State] = {start}
    queue: List[State] = [start]
    distinct_states = 1
    transitions = 0
    violations = []

    while queue:
        curr = queue.pop(0)
        if curr.atomicity_violation():
            violations.append(curr)

        for act, nxt in get_next_states(curr):
            transitions += 1
            if nxt not in visited:
                visited.add(nxt)
                distinct_states += 1
                queue.append(nxt)

    print(f"Model Checking Completed.")
    print(f"State space explored: {distinct_states} distinct states generated.")
    print(f"Total transitions checked: {transitions}.")
    print(f"Invariant violations found: {len(violations)}.")
    if violations:
        print("Violation detected in states:", violations)
    else:
        print("Invariant Atomicity is satisfied in all reached states.")

if __name__ == "__main__":
    model_check()
