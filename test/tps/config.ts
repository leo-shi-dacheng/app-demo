import fs from "node:fs";
import type { BenchmarkConfig, EncryptMode } from "./types";

const MIN_TPS_WALLETS = 25;
const DEFAULT_WALLET_CSV_PATH = "docs/whitelist-users.csv";

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = parseInteger(value, fallback);
  if (parsed <= 0) throw new Error(`${name} must be greater than 0`);
  return parsed;
}

function parseList(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

function parseCsvLine(line: string): string[] {
  return line.split(",").map(item => item.trim());
}

export function parseWalletCsv(csv: string): { privateKeys: string[]; recipientAddresses: string[]; decryptPrivateKeys: string[] } {
  const lines = csv
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length < 2) throw new Error("wallet CSV must contain a header and at least one wallet");

  const headers = parseCsvLine(lines[0]);
  const addressIndex = headers.indexOf("address");
  const privateKeyIndex = headers.indexOf("private_key");
  if (addressIndex === -1) throw new Error("wallet CSV missing address column");
  if (privateKeyIndex === -1) throw new Error("wallet CSV missing private_key column");

  const wallets = lines.slice(1)
    .map(parseCsvLine)
    .map(row => ({
      address: row[addressIndex],
      privateKey: row[privateKeyIndex],
    }))
    .filter(wallet => wallet.address && wallet.privateKey);

  if (wallets.length < 2) {
    throw new Error("wallet CSV must contain at least two complete wallets");
  }

  const pairs: Array<{
    sender: { address: string; privateKey: string };
    recipient: { address: string; privateKey: string };
  }> = [];
  for (let index = 0; index + 1 < wallets.length; index += 2) {
    pairs.push({
      sender: wallets[index],
      recipient: wallets[index + 1],
    });
  }

  if (pairs.length === 0) {
    throw new Error("wallet CSV must contain at least one complete sender/recipient pair");
  }

  return {
    privateKeys: pairs.map(pair => pair.sender.privateKey),
    recipientAddresses: pairs.map(pair => pair.recipient.address),
    decryptPrivateKeys: wallets.map(wallet => wallet.privateKey),
  };
}

function loadWalletCsv(env: NodeJS.ProcessEnv) {
  const csvPath = env.TPS_WALLET_CSV || DEFAULT_WALLET_CSV_PATH;
  if (!fs.existsSync(csvPath)) return undefined;
  return parseWalletCsv(fs.readFileSync(csvPath, "utf8"));
}

function parseEncryptMode(env: NodeJS.ProcessEnv): EncryptMode {
  const explicit = (env.TPS_ENCRYPT_MODE || "").trim().toLowerCase();
  if (explicit === "pre" || explicit === "inline") return explicit;

  const preEncrypt = (env.TPS_PRE_ENCRYPT || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(preEncrypt)) return "pre";
  if (["0", "false", "no", "off"].includes(preEncrypt)) return "inline";

  return "pre";
}

function validateEncryptionSource(env: NodeJS.ProcessEnv): void {
  const source = (env.TPS_ENCRYPTION_SOURCE || "sdk").trim().toLowerCase();
  if (source === "sdk") return;
  throw new Error(`TPS_ENCRYPTION_SOURCE must be "sdk", got "${source}"`);
}

export function parseBenchmarkConfig(env: NodeJS.ProcessEnv = process.env): BenchmarkConfig {
  const walletCsv = loadWalletCsv(env);
  const privateKeys = parseList(env.TPS_PRIVATE_KEYS);
  if (walletCsv && privateKeys.length === 0 && !env.PRIVATE_KEY) {
    privateKeys.push(...walletCsv.privateKeys);
  }
  if (env.PRIVATE_KEY && privateKeys.length === 0) privateKeys.push(env.PRIVATE_KEY);
  const decryptPrivateKeys = walletCsv?.decryptPrivateKeys.length
    ? walletCsv.decryptPrivateKeys
    : privateKeys;

  const recipientAddresses = parseList(env.TPS_RECIPIENTS);
  if (env.TPS_RECIPIENT && recipientAddresses.length === 0) {
    recipientAddresses.push(env.TPS_RECIPIENT);
  }
  if (walletCsv && recipientAddresses.length === 0) {
    recipientAddresses.push(...walletCsv.recipientAddresses);
  }

  const required = {
    PRIVATE_KEY: privateKeys.length > 0,
    RPC_URL: Boolean(env.RPC_URL),
    PUSDC_TOKEN_ADDRESS: Boolean(env.PUSDC_TOKEN_ADDRESS),
    ACL_ADDRESS: Boolean(env.ACL_ADDRESS),
    TPS_RECIPIENTS: recipientAddresses.length > 0,
  };
  const missing = Object.entries(required)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);
  if (missing.length > 0) throw new Error(`Missing: ${missing.join(" / ")}`);
  if (privateKeys.length < MIN_TPS_WALLETS) {
    throw new Error(`TPS benchmark requires at least ${MIN_TPS_WALLETS} sender wallets`);
  }

  const completionMode = (env.TPS_MODE || "balance").trim().toLowerCase();
  if (completionMode !== "balance" && completionMode !== "event") {
    throw new Error(`TPS_MODE must be "balance" or "event", got "${completionMode}"`);
  }
  if (completionMode === "event" && !env.TPS_SETTLEMENT_EVENT) {
    throw new Error("TPS_SETTLEMENT_EVENT is required when TPS_MODE=event");
  }

  const txCount = env.TPS_TX_COUNT ? parseInteger(env.TPS_TX_COUNT, 0) : undefined;
  const txDelayMs = parseInteger(env.TPS_TX_DELAY, 200);
  const waveSize = parsePositiveInteger(env.TPS_WAVE_SIZE, privateKeys.length, "TPS_WAVE_SIZE");
  const sendConcurrency = parsePositiveInteger(env.TPS_SEND_CONCURRENCY, waveSize, "TPS_SEND_CONCURRENCY");
  const waveDelayMs = parseInteger(env.TPS_WAVE_DELAY, 0);
  const encryptMode = parseEncryptMode(env);
  validateEncryptionSource(env);
  if (waveDelayMs < 0) throw new Error("TPS_WAVE_DELAY must be greater than or equal to 0");
  if (sendConcurrency > waveSize) {
    throw new Error("TPS_SEND_CONCURRENCY cannot exceed TPS_WAVE_SIZE");
  }
  if (encryptMode === "pre" && txDelayMs === 0 && !txCount) {
    throw new Error("TPS_TX_COUNT is required when TPS_ENCRYPT_MODE=pre and TPS_TX_DELAY=0");
  }
  return {
    privateKeys,
    decryptPrivateKeys,
    rpcUrl: env.RPC_URL!,
    tokenAddress: env.PUSDC_TOKEN_ADDRESS!,
    aclAddress: env.ACL_ADDRESS!,
    whitelistAddress: env.WHITELIST_ADDRESS || "",
    durationSeconds: parseInteger(env.TPS_DURATION, 60),
    txCount,
    amount: env.TPS_AMOUNT || "1",
    completionMode,
    pollIntervalMs: parseInteger(env.TPS_POLL_INTERVAL, 5000),
    settlementEvent: env.TPS_SETTLEMENT_EVENT || "",
    txDelayMs,
    sendConcurrency,
    waveSize,
    waveDelayMs,
    settleTimeoutMs: parseInteger(env.TPS_SETTLE_TIMEOUT, 120) * 1000,
    decryptTimeoutMs: parseInteger(env.TPS_DECRYPT_TIMEOUT, 15000000),
    confirmTimeoutMs: parseInteger(env.TPS_CONFIRM_TIMEOUT, 300) * 1000,
    encryptMode,
    recipientAddresses,
    transferValue: env.TPS_TRANSFER_VALUE || "",
    isMock: env.MOCK_TEST === "ON",
  };
}

export function plannedTransferCount(config: BenchmarkConfig): number {
  if (config.txCount && config.txCount > 0) return config.txCount;
  if (config.txDelayMs <= 0) {
    throw new Error("TPS_TX_COUNT is required when TPS_TX_DELAY=0");
  }
  return Math.max(1, Math.ceil((config.durationSeconds * 1000) / config.txDelayMs));
}
