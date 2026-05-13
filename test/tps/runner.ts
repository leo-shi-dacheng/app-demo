import type {
  BenchmarkConfig,
  BalanceSnapshot,
  PreparedTransfer,
  RuntimePair,
  TrackerStats,
  TxRecord,
} from "./types";
import { C } from "./colors";
import { plannedTransferCount } from "./config";
import {
  average,
  fmt,
  formatTokenUnits,
  sleep,
  withTimeout,
} from "./metrics";
import {
  createRuntime,
  encryptTransferAmount,
  ensureControllerWhitelisted,
  getDecryptedBalanceUnits,
  sendPreparedTransfer,
} from "./runtime";
import { trackViaBalances, trackViaEvent } from "./trackers";

function pairForIndex(pairs: RuntimePair[], index: number): RuntimePair {
  return pairs[index % pairs.length];
}

export function planRecipientBaselines(
  pairs: Array<Pick<RuntimePair, "recipientAddress">>,
  txCount: number
): string[] {
  const recipients: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < txCount; i++) {
    const recipient = pairs[i % pairs.length].recipientAddress.toLowerCase();
    if (seen.has(recipient)) continue;
    seen.add(recipient);
    recipients.push(recipient);
  }

  return recipients;
}

export interface SendWavePlan {
  id: number;
  txIds: number[];
  pairIds: number[];
}

export function planSendWaves(txCount: number, pairCount: number, waveSize: number): SendWavePlan[] {
  if (txCount <= 0) throw new Error("TPS_TX_COUNT must be greater than 0");
  if (pairCount <= 0) throw new Error("At least one sender pair is required");
  if (waveSize <= 0) throw new Error("TPS_WAVE_SIZE must be greater than 0");
  if (waveSize > pairCount) throw new Error("TPS_WAVE_SIZE cannot exceed sender pair count");

  const waves: SendWavePlan[] = [];
  for (let start = 0; start < txCount; start += waveSize) {
    const txIds = Array.from(
      { length: Math.min(waveSize, txCount - start) },
      (_, index) => start + index + 1
    );
    waves.push({
      id: waves.length + 1,
      txIds,
      pairIds: txIds.map(txId => ((txId - 1) % pairCount) + 1),
    });
  }
  return waves;
}

async function prepareTransfers(
  config: BenchmarkConfig,
  runtime: Awaited<ReturnType<typeof createRuntime>>
): Promise<PreparedTransfer[]> {
  const total = plannedTransferCount(config);
  const prepared: PreparedTransfer[] = [];
  const startedAt = Date.now();

  console.log(`${C.yellow}Preparing encrypted payloads: ${total}${C.reset}`);
  for (let i = 0; i < total; i++) {
    const pair = pairForIndex(runtime.pairs, i);
    const preparedTransfer = await encryptTransferAmount(runtime, config, pair, i + 1);
    prepared.push(preparedTransfer);
    console.log(
      `${C.dim}[ENC ${preparedTransfer.id}] pair=${pair.id} ` +
      `${fmt(preparedTransfer.encryptionMs)}${C.reset}`
    );
  }

  const windowSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
  console.log(
    `${C.green}Encryption prepared: ${prepared.length} payloads, ` +
    `${(prepared.length / windowSeconds).toFixed(3)} enc/s${C.reset}\n`
  );
  return prepared;
}

async function captureRecipientBaselines(
  config: BenchmarkConfig,
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  plannedTxCount: number
): Promise<BalanceSnapshot[]> {
  const recipients = planRecipientBaselines(runtime.pairs, plannedTxCount);
  const snapshots: BalanceSnapshot[] = [];

  for (const recipient of recipients) {
    const balance = await getDecryptedBalanceUnits(runtime, config, recipient);
    if (balance === null) throw new Error(`Failed to fetch recipient baseline: ${recipient}`);
    snapshots.push({ address: recipient, baselineUnits: balance });
    console.log(`${C.bold}Recipient baseline ${recipient}: ${formatTokenUnits(balance, runtime.decimals)}${C.reset}`);
  }

  return snapshots;
}

function attachConfirmation(record: TxRecord, txResp: Awaited<ReturnType<typeof sendPreparedTransfer>>) {
  return txResp.wait().then(receipt => {
    if (receipt) {
      if (receipt.status === 0) {
        record.error = `receipt status=0 block=${receipt.blockNumber}`;
        console.error(`${C.red}[TX ${record.id}] reverted ${record.error}${C.reset}`);
        return;
      }

      record.onChainAt = Date.now();
      console.log(
        `${C.yellow}[TX ${record.id}] confirmed ${fmt(record.onChainAt - record.initiatedAt)} ` +
        `block=${receipt.blockNumber}${C.reset}`
      );
    } else {
      record.error = "receipt is null";
    }
  }).catch((e: any) => {
    record.error = e?.message ?? String(e);
    console.error(`${C.red}[TX ${record.id}] confirmation failed: ${record.error}${C.reset}`);
  });
}

function printCompletionObserver(stats: TrackerStats) {
  console.log(`${C.bold}Completion observer:${C.reset}`);

  if (stats.mode === "balance") {
    const successfulDecrypts = stats.decryptAttempts - stats.decryptFailures;
    const avgDecryptMs = stats.decryptLatenciesMs.length > 0
      ? fmt(average(stats.decryptLatenciesMs))
      : "n/a";
    console.log(`  Mode           : balance (decrypted recipient balance delta)`);
    console.log(`  Poll interval  : ${fmt(stats.pollIntervalMs ?? 0)}`);
    console.log(`  Poll rounds    : ${stats.polls}`);
    console.log(`  Decrypt calls  : ${stats.decryptAttempts} (${successfulDecrypts} ok / ${stats.decryptFailures} failed)`);
    console.log(`  Avg decrypt    : ${avgDecryptMs}`);
    console.log(`  TPS note       : End-to-End TPS includes polling and decrypt observation delay.\n`);
    return;
  }

  console.log(`  Mode           : event (${stats.observedEvents || 0} observed)`);
  console.log(`  TPS note       : Event mode is only a completion signal if the event means settlement done.\n`);
}

export function getReportTpsMetricLabels(): string[] {
  return ["Send Rate", "On-chain TPS", "FHE TPS", "End-to-End TPS"];
}

function printReport(records: TxRecord[], testStart: number, testEndTime: number, trackerStats: TrackerStats) {
  const total = records.length;
  const failed = records.filter(r => r.error).length;
  const confirmed = records.filter(r => r.onChainAt).length;
  const completed = records.filter(r => r.completedAt).length;
  const done = records.filter(r => r.completedAt);
  const encrypted = records.filter(r => typeof r.encryptionMs === "number");
  const sent = records.filter(r => r.txHash);
  const confirmedRecords = records.filter(r => r.onChainAt);

  console.log(`\n${C.bold}${C.cyan}══════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}${C.cyan}  Results${C.reset}`);
  console.log(`${C.bold}${C.cyan}══════════════════════════════════════════${C.reset}\n`);
  console.log(`${C.bold}Transaction summary:${C.reset}`);
  console.log(`  Initiated  : ${total}`);
  console.log(`  Failed     : ${C.red}${failed}${C.reset}`);
  console.log(`  Confirmed  : ${C.yellow}${confirmed}${C.reset}`);
  console.log(`  Completed  : ${C.green}${completed}${C.reset}\n`);

  if (encrypted.length > 0) {
    const firstEncryptStarted = Math.min(...encrypted.map(r => (r.encryptedAt ?? r.initiatedAt) - (r.encryptionMs ?? 0)));
    const lastEncryptedAt = Math.max(...encrypted.map(r => r.encryptedAt ?? r.initiatedAt));
    const encryptWindowS = Math.max((lastEncryptedAt - firstEncryptStarted) / 1000, 0.001);
    console.log(`${C.bold}Encryption:${C.reset}`);
    console.log(`  Payloads       : ${encrypted.length}`);
    console.log(`  Avg latency    : ${fmt(average(encrypted.map(r => r.encryptionMs ?? 0)))}`);
    console.log(`  Encrypt TPS    : ${(encrypted.length / encryptWindowS).toFixed(3)} enc/s\n`);
  }

  printCompletionObserver(trackerStats);

  if (sent.length === 0) {
    console.log(`${C.red}No sent transactions — cannot calculate TPS.${C.reset}`);
    return;
  }

  const firstSentAt = Math.min(...sent.map(r => r.initiatedAt));
  const lastSentAt = Math.max(...sent.map(r => r.initiatedAt));
  const sendWindowS = lastSentAt > firstSentAt
    ? (lastSentAt - firstSentAt) / 1000
    : Math.max((testEndTime - testStart) / 1000, 0.001);
  const sendRate = sent.length / sendWindowS;

  console.log(`${C.bold}Latency:${C.reset}`);
  if (confirmedRecords.length > 0) {
    console.log(`  Avg on-chain confirmation : ${fmt(average(confirmedRecords.map(r => r.onChainAt! - r.initiatedAt)))}`);
  } else {
    console.log(`  Avg on-chain confirmation : n/a`);
  }

  if (done.length > 0) {
    console.log(`  Avg off-chain FHE compute : ${fmt(average(done.map(r => r.completedAt! - (r.onChainAt ?? r.initiatedAt))))}`);
    console.log(`  Avg end-to-end            : ${fmt(average(done.map(r => r.completedAt! - r.initiatedAt)))}\n`);
  } else {
    console.log(`  Avg off-chain FHE compute : n/a`);
    console.log(`  Avg end-to-end            : n/a\n`);
  }

  console.log(`${C.bold}${C.green}TPS metrics:${C.reset}`);
  console.log(`  Send Rate      : ${C.yellow}${sendRate.toFixed(3)} tx/s${C.reset}`);

  if (confirmedRecords.length > 0) {
    const firstConfirmedAt = Math.min(...confirmedRecords.map(r => r.onChainAt!));
    const lastConfirmedAt = Math.max(...confirmedRecords.map(r => r.onChainAt!));
    const lastCompletedAt = Math.max(...done.map(r => r.completedAt!));
    const onChainWindowS = (lastConfirmedAt - firstConfirmedAt) / 1000;
    const onChainTPS = onChainWindowS > 0 ? confirmed / onChainWindowS : confirmed;
    console.log(`  On-chain TPS   : ${C.yellow}${onChainTPS.toFixed(3)} tx/s${C.reset}`);

    if (done.length > 0) { 
      // FHE TPS: window from last on-chain confirmation to last FHE completion
      const fheWindowS = (lastCompletedAt - lastConfirmedAt) / 1000;
      const fheTPS = completed / Math.max(fheWindowS, 0.001);
      console.log(`  FHE TPS        : ${C.yellow}${fheTPS.toFixed(6)} tx/s${C.reset}  (window=${fheWindowS.toFixed(1)}s)`);

      // End-to-End TPS: window from first initiation to last completion
      const firstInitiatedAt = Math.min(...done.map(r => r.initiatedAt));
      const e2eWindowS = (lastCompletedAt - firstInitiatedAt) / 1000;
      const effectiveTPS = completed / Math.max(e2eWindowS, 0.001);
      console.log(`  End-to-End TPS : ${C.cyan}${effectiveTPS.toFixed(6)} tx/s${C.reset}  (window=${e2eWindowS.toFixed(1)}s)`);
    } else {
      console.log(`  FHE TPS        : n/a (no balance settlements observed)`);
      console.log(`  End-to-End TPS : n/a (no balance settlements observed)`);
    }
  } else {
    console.log(`  On-chain TPS   : n/a (no confirmed transactions)`);
    console.log(`  FHE TPS        : n/a (no balance settlements observed)`);
    console.log(`  End-to-End TPS : n/a (no balance settlements observed)`);
  }
}

export async function runBenchmark(config: BenchmarkConfig) {
  const runtime = await createRuntime(config);
  const controllerWhitelisted = await ensureControllerWhitelisted(runtime);
  if (controllerWhitelisted) console.log(`${C.green}Controller wallet whitelisted for decrypt.${C.reset}`);

  console.log(`\n${C.bold}${C.cyan}══════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}${C.cyan}  FHE ERC20 TPS Benchmark${C.reset}`);
  console.log(`${C.bold}${C.cyan}══════════════════════════════════════════${C.reset}\n`);
  console.log(`  Sender pairs   : ${runtime.pairs.length}`);
  console.log(`  Contract       : ${config.tokenAddress}`);
  console.log(`  Amount         : ${config.amount}`);
  console.log(`  Encrypt mode   : ${config.encryptMode}`);
  console.log(`  Completion     : ${config.completionMode}`);
  console.log(`  Duration       : ${config.durationSeconds}s`);
  console.log(`  TX count       : ${config.txCount ?? "derived from duration/delay"}`);
  console.log(`  TX delay       : ${config.txDelayMs}ms`);
  console.log(`  Wave size      : ${config.waveSize}`);
  console.log(`  Send concurrency: ${config.sendConcurrency}`);
  console.log(`  Wave delay     : ${config.waveDelayMs}ms\n`);

  for (const pair of runtime.pairs) {
    console.log(`${C.dim}[pair ${pair.id}] ${pair.senderAddress} -> ${pair.recipientAddress}, nonce=${pair.nonce}${C.reset}`);
  }

  const plannedTxCount = config.txCount ?? plannedTransferCount(config);
  const prepared = config.encryptMode === "pre"
    ? await prepareTransfers(config, runtime)
    : [];
  const snapshots = config.completionMode === "balance"
    ? await captureRecipientBaselines(config, runtime, plannedTxCount)
    : [];

  const records: TxRecord[] = [];
  let sendDone = false;
  const trackerDone = config.completionMode === "event"
    ? trackViaEvent(runtime, config, { records, isSendDone: () => sendDone })
    : trackViaBalances(runtime, config, snapshots, { records, isSendDone: () => sendDone });

  const testStart = Date.now();
  const testEndAt = testStart + config.durationSeconds * 1000;
  const confirmPromises: Promise<void>[] = [];
  const sendWaves = planSendWaves(plannedTxCount, runtime.pairs.length, config.waveSize);

  const sendById = async (txId: number) => {
    const pair = pairForIndex(runtime.pairs, txId - 1);
    const preparedTransfer = config.encryptMode === "pre"
      ? prepared[txId - 1]
      : await encryptTransferAmount(runtime, config, pair, txId);

    const record: TxRecord = {
      id: txId,
      pairId: pair.id,
      from: pair.senderAddress,
      to: preparedTransfer.recipientAddress,
      txHash: "",
      initiatedAt: config.encryptMode === "inline"
        ? preparedTransfer.encryptedAt - preparedTransfer.encryptionMs
        : Date.now(),
      encryptedAt: preparedTransfer.encryptedAt,
      encryptionMs: preparedTransfer.encryptionMs,
    };
    records.push(record);

    try {
      const txResp = await sendPreparedTransfer(runtime, pair, preparedTransfer);
      record.txHash = txResp.hash;
      console.log(
        `${C.dim}[TX ${record.id}] pair=${pair.id} nonce=${pair.nonce - 1} ` +
        `hash=${txResp.hash.slice(0, 12)}...${C.reset}`
      );
      confirmPromises.push(attachConfirmation(record, txResp));
    } catch (e: any) {
      record.error = e?.message ?? String(e);
      console.error(`${C.red}[TX ${record.id}] send failed: ${record.error}${C.reset}`);
    }
  };

  for (const wave of sendWaves) {
    if (Date.now() >= testEndAt) break;
    console.log(`${C.cyan}[wave ${wave.id}] sending ${wave.txIds.length} txs, pairs=${wave.pairIds[0]}-${wave.pairIds[wave.pairIds.length - 1]}${C.reset}`);

    for (let i = 0; i < wave.txIds.length; i += config.sendConcurrency) {
      const batch = wave.txIds.slice(i, i + config.sendConcurrency);
      await Promise.all(batch.map(sendById));
    }

    if (config.waveDelayMs > 0 && wave.id < sendWaves.length) {
      await sleep(config.waveDelayMs);
    }
  }

  sendDone = true;
  const testEndTime = Date.now();
  await withTimeout(
    Promise.all(confirmPromises),
    config.confirmTimeoutMs,
    `confirmation timeout after ${config.confirmTimeoutMs / 1000}s`
  );
  const trackerStats = await trackerDone;
  printReport(records, testStart, testEndTime, trackerStats);
}
