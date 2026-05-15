import type { Contract, JsonRpcProvider, Wallet } from "ethers";

export type CompletionMode = "balance" | "event";
export type EncryptMode = "pre" | "inline";

export interface BenchmarkConfig {
  privateKeys: string[];
  decryptPrivateKeys: string[];
  rpcUrl: string;
  tokenAddress: string;
  aclAddress: string;
  whitelistAddress: string;
  settlementContractAddress: string;
  durationSeconds: number;
  txCount?: number;
  amount: string;
  completionMode: CompletionMode;
  pollIntervalMs: number;
  settlementEvent: string;
  txDelayMs: number;
  sendConcurrency: number;
  waveSize: number;
  waveDelayMs: number;
  settleTimeoutMs: number;
  decryptTimeoutMs: number;
  confirmTimeoutMs: number;
  encryptMode: EncryptMode;
  recipientAddresses: string[];
  transferValue: string;
}

export interface AddressPair {
  id: number;
  senderAddress: string;
  recipientAddress: string;
}

export interface RuntimePair extends AddressPair {
  wallet: Wallet;
  contract: Contract;
  nonce: number;
}

export interface BenchmarkRuntime {
  config: BenchmarkConfig;
  provider: JsonRpcProvider;
  controllerWallet: Wallet;
  controllerContract: Contract;
  settlementContract?: Contract;
  pairs: RuntimePair[];
  decryptWallets: Wallet[];
  chainId: number;
  decimals: number;
  amountUnits: bigint;
  totalFee: bigint;
}

export interface PreparedTransfer {
  id: number;
  pairId: number;
  recipientAddress: string;
  amountHandle: unknown;
  encryptedAt: number;
  encryptionMs: number;
}

export interface TxRecord {
  id: number;
  pairId: number;
  from: string;
  to: string;
  txHash: string;
  initiatedAt: number;
  encryptedAt?: number;
  encryptionMs?: number;
  onChainAt?: number;
  completedAt?: number;
  error?: string;
}

export interface BalanceSnapshot {
  address: string;
  baselineUnits: bigint;
  expectedSettlements: number;
}

export interface TrackerStats {
  mode: CompletionMode;
  polls: number;
  decryptAttempts: number;
  decryptFailures: number;
  decryptLatenciesMs: number[];
  pollIntervalMs?: number;
  observedEvents?: number;
}
