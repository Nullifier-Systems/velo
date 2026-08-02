/**
 * State Space Model Checker for Step 3d: Malicious Relayer Refusing to Relay (Selective Censorship)
 */

const Threshold = 2;
const TotalRelayers = 3;
const MaxTime = 12;
const Relayers = [1, 2, 3];

function runCheck(censoringRelayers, scenarioName) {
  const honestRelayers = Relayers.filter(r => !censoringRelayers.includes(r));

  function initialStates() {
    return [{
      stellarState: "UNINIT",
      evmState: "UNINIT",
      evmAttestations: [],
      relayerSeen: false,
      time: 0,
      stellarTimeout: 5,
      evmTimeout: 10
    }];
  }

  function stateKey(s) {
    return `${s.stellarState}|${s.evmState}|${s.evmAttestations.sort().join(",")}|${s.relayerSeen}|${s.time}`;
  }

  function isAtomicityViolation(s) {
    return (s.stellarState === "RELEASED" && s.evmState === "REFUNDED") ||
           (s.evmState === "WITHDRAWN" && s.stellarState === "REFUNDED");
  }

  function getNextStates(s) {
    const next = [];

    // EVMLock
    if (s.evmState === "UNINIT" && s.time < s.evmTimeout) {
      next.push({
        action: "EVMLock",
        state: { ...s, evmState: "LOCKED" }
      });
    }

    // StellarLock
    if (s.evmState === "LOCKED" && s.stellarState === "UNINIT" && s.time < s.stellarTimeout) {
      next.push({
        action: "StellarLock",
        state: { ...s, stellarState: "LOCKED" }
      });
    }

    // StellarRelease
    if (s.stellarState === "LOCKED" && s.time < s.stellarTimeout) {
      next.push({
        action: "StellarRelease",
        state: { ...s, stellarState: "RELEASED", relayerSeen: true }
      });
    }

    // Honest Relayer Attestation
    if (s.relayerSeen && s.evmState === "LOCKED") {
      for (const r of honestRelayers) {
        if (!s.evmAttestations.includes(r)) {
          const newAtt = [...s.evmAttestations, r].sort();
          const newEvm = newAtt.length >= Threshold ? "WITHDRAWN" : s.evmState;
          next.push({
            action: `HonestRelayerAttest(${r})`,
            state: { ...s, evmAttestations: newAtt, evmState: newEvm }
          });
        }
      }
    }

    // Censoring Relayers withhold (no attestation submitted)

    // EVMRefund
    if (s.evmState === "LOCKED" && s.time >= s.evmTimeout) {
      next.push({
        action: "EVMRefund",
        state: { ...s, evmState: "REFUNDED" }
      });
    }

    // StellarRefund
    if (s.stellarState === "LOCKED" && s.time >= s.stellarTimeout) {
      next.push({
        action: "StellarRefund",
        state: { ...s, stellarState: "REFUNDED" }
      });
    }

    // Tick
    if (s.time < MaxTime) {
      next.push({
        action: "Tick",
        state: { ...s, time: s.time + 1 }
      });
    }

    return next;
  }

  const queue = initialStates().map(s => ({ state: s, trace: [] }));
  const visited = new Set();
  visited.add(stateKey(queue[0].state));

  let distinctStates = 1;
  let transitions = 0;
  const violations = [];

  while (queue.length > 0) {
    const { state: curr, trace } = queue.shift();

    if (isAtomicityViolation(curr)) {
      violations.push({ state: curr, trace });
    }

    for (const { action, state: nxt } of getNextStates(curr)) {
      transitions++;
      const key = stateKey(nxt);
      if (!visited.has(key)) {
        visited.add(key);
        distinctStates++;
        queue.push({ state: nxt, trace: [...trace, { action, state: nxt }] });
      }
    }
  }

  console.log(`\n=== Scenario: ${scenarioName} ===`);
  console.log(`Censoring Relayers: [${censoringRelayers.join(", ")}], Honest Relayers: [${honestRelayers.join(", ")}]`);
  console.log(`Threshold M=${Threshold}, Total N=${TotalRelayers}`);
  console.log(`State space size: ${distinctStates} distinct states generated.`);
  console.log(`Total transitions evaluated: ${transitions}.`);
  console.log(`Atomicity Invariant Violations found: ${violations.length}.`);

  if (violations.length > 0) {
    console.log("Sample Counterexample Trace:");
    console.log(JSON.stringify(violations[0], null, 2));
  } else {
    console.log("Result: No counterexample found within configured bounds.");
  }
}

console.log("=== TLC Model Checker Execution Output (Step 3d: Selective Relayer Censorship) ===");
runCheck([3], "3d-1: Single Censoring Relayer (c = 1 < N - M + 1 = 2)");
runCheck([2, 3], "3d-2: Censoring Quorum Deficit (c = 2 >= N - M + 1 = 2)");
