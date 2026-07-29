// ---------------------------------------------------------------------------
// Read helpers — pause / circuit breaker (issue #266)
// ---------------------------------------------------------------------------

export interface EscrowPauseState {
    /** True only when a pause is armed AND the delay has elapsed. */
    paused: boolean;
    /** Ledger when an armed pause becomes effective; null if not armed. */
    pause_effective_ledger: number | null;
    /** Fixed delay (ledgers) between pause() and effective lock blocking. */
    pause_delay_ledgers: number;
}

/** Source account for read-only simulations (does not need to sign). */
async function simulationAccount(): Promise<Account> {
    const configured =
        process.env.SOROBAN_SIMULATION_SOURCE ||
        process.env.BUYER_PUBLIC_KEY ||
        (process.env.BUYER_SECRET_KEY
            ? Keypair.fromSecret(process.env.BUYER_SECRET_KEY).publicKey()
            : null);

    if (configured) {
        try {
            return await server.getAccount(configured);
        } catch {
            // Fall through to ephemeral account if the key is not funded on this network.
        }
    }

    return new Account(Keypair.random().publicKey(), "0");
}

async function simulateContractRead<T>(
    contractId: string,
    functionName: string,
    args: xdr.ScVal[] = [],
): Promise<T> {
    const account = await simulationAccount();
    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(
            Operation.invokeContractFunction({
                contract: contractId,
                function: functionName,
                args,
            })
        )
        .setTimeout(30)
        .build();

    const sim = await server.simulateTransaction(tx);
    if (Api.isSimulationError(sim)) {
        throw new Error(`simulation failed (${functionName}): ${sim.error}`);
    }
    if (!Api.isSimulationSuccess(sim) || sim.result === undefined) {
        throw new Error(`simulation returned no result for ${functionName}`);
    }

    return scValToNative(sim.result.retval) as T;
}

/**
 * Read the escrow circuit-breaker state from chain (issue #266).
 * Used by the API to refuse new locks and by the frontend to show a clear message.
 */
export async function getEscrowPauseState(contractId: string): Promise<EscrowPauseState> {
    const [paused, effective, delay] = await Promise.all([
        simulateContractRead<boolean>(contractId, "is_paused"),
        simulateContractRead<number | null | undefined>(contractId, "pause_effective_ledger"),
        simulateContractRead<number>(contractId, "pause_delay_ledgers"),
    ]);

    return {
        paused: Boolean(paused),
        pause_effective_ledger:
            effective === null || effective === undefined ? null : Number(effective),
        pause_delay_ledgers: Number(delay),
    };
}

// ---------------------------------------------------------------------------
// Session Account Contract Functions
// ---------------------------------------------------------------------------

export interface SessionAccountParams {
  contractId: string;
  mainAccount: string;
}

export interface CreateSessionKeyParams {
  contractId: string;
  sessionKey: string;
  spendingCap: bigint;
  durationDays: number;
  startDelayDays: number;
}

export interface RevokeSessionKeyParams {
  contractId: string;
  sessionKey: string;
}

export interface UpdateSpendingCapParams {
  contractId: string;
  sessionKey: string;
  newSpendingCap: bigint;
}

export async function initializeSessionAccount(params: SessionAccountParams): Promise<{ hash: string }> {
  const signer = loadSignerKeypair();
  return invokeContract(
    params.contractId,
    "initialize",
    [nativeToScVal(params.mainAccount, { type: "address" })],
    signer,
  ) as Promise<{ hash: string }>;
}

export async function buildInitializeSessionAccountTx(params: SessionAccountParams & { signerPublicKey: string }): Promise<string> {
  const account = await server.getAccount(params.signerPublicKey);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: params.contractId,
        function: "initialize",
        args: [nativeToScVal(params.mainAccount, { type: "address" })],
      })
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }

  const prepared = assembleTransaction(tx, sim).build();
  return prepared.toXDR();
}

export async function createSessionKey(params: CreateSessionKeyParams): Promise<{ hash: string }> {
  const signer = loadSignerKeypair();
  return invokeContract(
    params.contractId,
    "create_session_key",
    [
      nativeToScVal(params.sessionKey, { type: "address" }),
      nativeToScVal(params.spendingCap, { type: "i128" }),
      nativeToScVal(params.durationDays, { type: "u32" }),
      nativeToScVal(params.startDelayDays, { type: "u32" }),
    ],
    signer,
  ) as Promise<{ hash: string }>;
}

export async function buildCreateSessionKeyTx(params: CreateSessionKeyParams & { signerPublicKey: string }): Promise<string> {
  const account = await server.getAccount(params.signerPublicKey);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: params.contractId,
        function: "create_session_key",
        args: [
          nativeToScVal(params.sessionKey, { type: "address" }),
          nativeToScVal(params.spendingCap, { type: "i128" }),
          nativeToScVal(params.durationDays, { type: "u32" }),
          nativeToScVal(params.startDelayDays, { type: "u32" }),
        ],
      })
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }

  const prepared = assembleTransaction(tx, sim).build();
  return prepared.toXDR();
}

export async function revokeSessionKey(params: RevokeSessionKeyParams): Promise<{ hash: string }> {
  const signer = loadSignerKeypair();
  return invokeContract(
    params.contractId,
    "revoke_session_key",
    [nativeToScVal(params.sessionKey, { type: "address" })],
    signer,
  ) as Promise<{ hash: string }>;
}

export async function buildRevokeSessionKeyTx(params: RevokeSessionKeyParams & { signerPublicKey: string }): Promise<string> {
  const account = await server.getAccount(params.signerPublicKey);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: params.contractId,
        function: "revoke_session_key",
        args: [nativeToScVal(params.sessionKey, { type: "address" })],
      })
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }

  const prepared = assembleTransaction(tx, sim).build();
  return prepared.toXDR();
}

export async function updateSpendingCap(params: UpdateSpendingCapParams): Promise<{ hash: string }> {
  const signer = loadSignerKeypair();
  return invokeContract(
    params.contractId,
    "update_spending_cap",
    [
      nativeToScVal(params.sessionKey, { type: "address" }),
      nativeToScVal(params.newSpendingCap, { type: "i128" }),
    ],
    signer,
  ) as Promise<{ hash: string }>;
}

export async function buildUpdateSpendingCapTx(params: UpdateSpendingCapParams & { signerPublicKey: string }): Promise<string> {
  const account = await server.getAccount(params.signerPublicKey);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: params.contractId,
        function: "update_spending_cap",
        args: [
          nativeToScVal(params.sessionKey, { type: "address" }),
          nativeToScVal(params.newSpendingCap, { type: "i128" }),
        ],
      })
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }

  const prepared = assembleTransaction(tx, sim).build();
  return prepared.toXDR();
}

export async function getSessionKeyInfo(contractId: string, sessionKey: string): Promise<any> {
  const signer = loadSignerKeypair();
  const account = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: "get_session_key",
        args: [nativeToScVal(sessionKey, { type: "address" })],
      })
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }

  if (!sim.result) {
    throw new Error("No result from simulation");
  }

  return scValToNative(sim.result.retval);
}

export async function getSessionKeySpent(contractId: string, sessionKey: string): Promise<bigint> {
  const signer = loadSignerKeypair();
  const account = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: "get_spent",
        args: [nativeToScVal(sessionKey, { type: "address" })],
      })
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }

  if (!sim.result) {
    throw new Error("No result from simulation");
  }

  return scValToNative(sim.result.retval) as bigint;
}