import { ethers } from "ethers";
import type { TxRecord } from "./types";

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function fmt(ms: number) {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

export function parseTokenUnits(value: string, decimals: number): bigint {
  return ethers.parseUnits(value, decimals);
}

export function addressWhitelistKey(address: string): string {
  return ethers.solidityPackedKeccak256(["address"], [address]);
}

export function formatTokenUnits(value: bigint, decimals: number): string {
  return ethers.formatUnits(value, decimals);
}

export function absUnitsDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

export function computeObservedSettlements(
  baselineUnits: bigint,
  currentUnits: bigint,
  amountUnits: bigint
): number {
  if (amountUnits <= 0n || currentUnits <= baselineUnits) return 0;
  const settled = (currentUnits - baselineUnits) / amountUnits;
  return Number(settled > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : settled);
}

export function markCompletedByObservedSettlements(
  txRecords: TxRecord[],
  observedSettlements: number,
  completedAt: number
): number {
  let completed = txRecords.filter(r => r.completedAt).length;
  let marked = 0;

  for (const r of txRecords) {
    if (completed >= observedSettlements) break;
    if (r.error || r.completedAt) continue;
    if (!r.onChainAt) break;

    r.completedAt = completedAt;
    completed++;
    marked++;
  }

  return marked;
}

export function markCompletedByRecipientSettlements(
  txRecords: TxRecord[],
  observedByRecipient: Map<string, number>,
  completedAt: number
): TxRecord[] {
  const marked: TxRecord[] = [];

  for (const [recipient, observedSettlements] of observedByRecipient) {
    const key = recipient.toLowerCase();
    let completed = txRecords.filter(
      r => r.to.toLowerCase() === key && r.completedAt
    ).length;

    for (const r of txRecords) {
      if (completed >= observedSettlements) break;
      if (r.to.toLowerCase() !== key || r.error || r.completedAt) continue;
      if (!r.onChainAt) break;

      r.completedAt = completedAt;
      completed++;
      marked.push(r);
    }
  }

  return marked;
}

export function isTrackerComplete(txRecords: TxRecord[], allSent: boolean): boolean {
  const hasTxs = txRecords.length > 0;
  const allConfirmed = txRecords.every(r => r.onChainAt || r.error);
  const allDone = txRecords.every(r => r.completedAt || r.error);

  return allSent && hasTxs && allConfirmed && allDone;
}

export function average(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
