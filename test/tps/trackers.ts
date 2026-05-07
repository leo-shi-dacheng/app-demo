import type { BenchmarkConfig, BenchmarkRuntime, BalanceSnapshot, TrackerStats, TxRecord } from "./types";
import { C } from "./colors";
import {
  computeObservedSettlements,
  fmt,
  formatTokenUnits,
  isTrackerComplete,
  markCompletedByObservedSettlements,
  markCompletedByRecipientSettlements,
  sleep,
} from "./metrics";
import { getDecryptedBalanceUnits } from "./runtime";

interface TrackerState {
  records: TxRecord[];
  isSendDone: () => boolean;
}

function logMarked(records: TxRecord[], completedAt: number, mode: string) {
  for (const r of records.filter(r => r.completedAt === completedAt)) {
    const recordCompletedAt = r.completedAt!;
    const total = recordCompletedAt - r.initiatedAt;
    const offChain = recordCompletedAt - (r.onChainAt ?? r.initiatedAt);
    console.log(
      `${C.green}[TX ${r.id}] complete (${mode}) ` +
      `total=${fmt(total)} off-chain=${fmt(offChain)}${C.reset}`
    );
  }
}

export async function trackViaBalances(
  runtime: BenchmarkRuntime,
  config: BenchmarkConfig,
  snapshots: BalanceSnapshot[],
  state: TrackerState
): Promise<TrackerStats> {
  console.log(
    `\n${C.cyan}[tracker] balance mode, recipients=${snapshots.length}, ` +
    `poll=${config.pollIntervalMs}ms${C.reset}`
  );

  const observedByRecipient = new Map<string, number>();
  const stats: TrackerStats = {
    mode: "balance",
    polls: 0,
    decryptAttempts: 0,
    decryptFailures: 0,
    decryptLatenciesMs: [],
    pollIntervalMs: config.pollIntervalMs,
  };

  while (true) {
    await sleep(config.pollIntervalMs);
    stats.polls++;

    for (const snapshot of snapshots) {
      const decryptStartedAt = Date.now();
      stats.decryptAttempts++;
      const currentUnits = await getDecryptedBalanceUnits(runtime, config, snapshot.address);
      stats.decryptLatenciesMs.push(Date.now() - decryptStartedAt);
      if (currentUnits === null) {
        stats.decryptFailures++;
        console.log(`${C.yellow}[tracker] decrypt failed for ${snapshot.address}${C.reset}`);
        continue;
      }

      const observed = computeObservedSettlements(
        snapshot.baselineUnits,
        currentUnits,
        runtime.amountUnits
      );
      observedByRecipient.set(
        snapshot.address.toLowerCase(),
        Math.max(observedByRecipient.get(snapshot.address.toLowerCase()) || 0, observed)
      );

      const deltaUnits = currentUnits > snapshot.baselineUnits
        ? currentUnits - snapshot.baselineUnits
        : 0n;
      console.log(
        `${C.dim}[tracker] recipient=${snapshot.address} ` +
        `delta=${formatTokenUnits(deltaUnits, runtime.decimals)} ` +
        `settled=${observedByRecipient.get(snapshot.address.toLowerCase()) || 0}${C.reset}`
      );
    }

    const completedAt = Date.now();
    const marked = markCompletedByRecipientSettlements(state.records, observedByRecipient, completedAt);
    if (marked.length > 0) logMarked(marked, completedAt, "balance");

    const allSent = state.isSendDone();
    const allConfirmed = state.records.every(r => r.onChainAt || r.error);
    if (isTrackerComplete(state.records, allSent)) {
      console.log(`${C.green}[tracker] all transactions completed${C.reset}`);
      break;
    }

    const confirmedTimes = state.records.filter(r => r.onChainAt).map(r => r.onChainAt!);
    const lastConfirmedAt = confirmedTimes.length > 0 ? Math.max(...confirmedTimes) : 0;
    if (allSent && allConfirmed && lastConfirmedAt > 0 && Date.now() > lastConfirmedAt + config.settleTimeoutMs) {
      const pending = state.records.filter(r => r.onChainAt && !r.completedAt && !r.error);
      console.log(`${C.yellow}[tracker] settle timeout, pending=${pending.length}${C.reset}`);
      break;
    }
  }

  return stats;
}

export async function trackViaEvent(
  runtime: BenchmarkRuntime,
  config: BenchmarkConfig,
  state: TrackerState
): Promise<TrackerStats> {
  console.log(`\n${C.cyan}[tracker] event mode, event=${config.settlementEvent}${C.reset}`);

  const stats: TrackerStats = {
    mode: "event",
    polls: 0,
    decryptAttempts: 0,
    decryptFailures: 0,
    decryptLatenciesMs: [],
    observedEvents: 0,
  };
  const markObserved = () => {
    if (!stats.observedEvents) return;
    const completedAt = Date.now();
    const before = state.records.filter(r => r.completedAt).length;
    markCompletedByObservedSettlements(state.records, stats.observedEvents, completedAt);
    if (state.records.filter(r => r.completedAt).length > before) {
      logMarked(state.records, completedAt, "event");
    }
  };

  runtime.controllerContract.on(config.settlementEvent, () => {
    stats.observedEvents = (stats.observedEvents || 0) + 1;
    markObserved();
  });

  while (true) {
    await sleep(1000);
    stats.polls++;
    markObserved();

    const allSent = state.isSendDone();
    const allConfirmed = state.records.every(r => r.onChainAt || r.error);
    if (isTrackerComplete(state.records, allSent)) break;

    const confirmedTimes = state.records.filter(r => r.onChainAt).map(r => r.onChainAt!);
    const lastConfirmedAt = confirmedTimes.length > 0 ? Math.max(...confirmedTimes) : 0;
    if (allSent && allConfirmed && lastConfirmedAt > 0 && Date.now() > lastConfirmedAt + config.settleTimeoutMs) {
      console.log(`${C.yellow}[tracker] settle timeout${C.reset}`);
      break;
    }
  }

  runtime.controllerContract.removeAllListeners(config.settlementEvent);
  return stats;
}
