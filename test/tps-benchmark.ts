#!/usr/bin/env tsx
/**
 * FHE ERC20 TPS Benchmark
 *
 * Usage:
 *   npx tsx test/tps-benchmark.ts
 *
 * Important modes:
 *   TPS_PRIVATE_KEYS=0x...,0x...  Sender wallets. Falls back to PRIVATE_KEY.
 *   TPS_RECIPIENTS=0x...,0x...    Optional recipients. If omitted, derived from wallet CSV.
 *   TPS_ENCRYPT_MODE=pre          Pre-encrypt payloads before transfer phase (default).
 *   TPS_ENCRYPT_MODE=inline       Encrypt inside the send loop, measuring end-to-end client flow.
 *   TPS_MODE=balance              Count completion from decrypted recipient balance deltas.
 *   TPS_TX_COUNT=100              Number of transfers to prepare/send.
 *   TPS_DURATION=600              Max send-phase duration in seconds.
 */

import "dotenv/config";
import { parseBenchmarkConfig } from "./tps/config";
import { runBenchmark } from "./tps/runner";
import { C } from "./tps/colors";

async function main() {
  const config = parseBenchmarkConfig();
  await runBenchmark(config);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`\n${C.red}${C.bold}Error: ${err?.message ?? err}${C.reset}`);
    if (err?.stack) console.error(err.stack);
    process.exit(1);
  });
}
