import 'dotenv/config';
import { Server } from '@stellar/stellar-sdk/rpc';
import { loadConfig, assertRunnable } from './config.js';
import { SorobanWatcher } from './soroban-watcher.js';
import { EthersEvmHtlcClient } from './evm-htlc.js';
import { Relayer } from './relayer.js';

function main() {
  const cfg = loadConfig();
  assertRunnable(cfg);

  const server = new Server(cfg.sorobanRpcUrl, {
    allowHttp: cfg.sorobanRpcUrl.startsWith('http://'),
  });

  const watcher = new SorobanWatcher(server, {
    contractId: cfg.sorobanContractId,
    startLedger: cfg.startLedger,
    pollIntervalMs: cfg.pollIntervalMs,
  });

  const evm = new EthersEvmHtlcClient(cfg.evmRpcUrl, cfg.evmPrivateKey, cfg.evmHtlcAddress);

  const relayer = new Relayer(watcher, evm);
  relayer.run();

  const shutdown = () => {
    console.log('[relayer] shutting down');
    relayer.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
