import { ethers } from "ethers";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { estimateFheFee, FheType, requestDecrypt, requestEncrypt } from "@primuslabs/fhe-sdk";
import { PUSDCTokenV2_1_ABI } from "../../src/abis/PUSDCTokenV2_1_ABI";
import { AlphatrionReward_ABI } from "../../src/abis/AlphatrionReward_ABI";
import type { AddressPair, BenchmarkConfig, BenchmarkRuntime, PreparedTransfer, RuntimePair } from "./types";
import { addressWhitelistKey, parseTokenUnits, sleep, withTimeout } from "./metrics";
import { buildAddressPairs } from "./wallet-plan";
import { plannedTransferCount } from "./config";

const WHITELIST_ABI = [
  "function verifyWhitelisted(bytes32 accountHash) view returns (bool)",
];

const DECRYPTION_PROTO_PATH = path.resolve(__dirname, "decryption.proto");

type GrpcCiphertext = {
  queryParams: string;
  queryUrl: string;
  queryMethod: string;
};

type GrpcDecryptResponse = {
  plaintexts?: Array<{
    handle?: string;
    plaintext?: string;
  }>;
};

type DecryptionServiceClient = grpc.Client & {
  DecryptHandle(
    request: { ciphertext: GrpcCiphertext },
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: GrpcDecryptResponse) => void
  ): grpc.ClientUnaryCall;
};

let decryptClientCache: DecryptionServiceClient | undefined;
let decryptClientCacheKey = "";

export async function createRuntime(config: BenchmarkConfig): Promise<BenchmarkRuntime> {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const controllerWallet = new ethers.Wallet(config.privateKeys[0], provider);
  const controllerContract = new ethers.Contract(config.tokenAddress, PUSDCTokenV2_1_ABI, controllerWallet);
  const settlementContract = config.settlementContractAddress
    ? new ethers.Contract(config.settlementContractAddress, AlphatrionReward_ABI, provider)
    : undefined;
  const chainId = Number((await provider.getNetwork()).chainId);
  const decimals = Number(await controllerContract.decimals());
  const amountUnits = parseTokenUnits(config.amount, decimals);
  if (amountUnits <= 0n) throw new Error("TPS_AMOUNT must be greater than 0");

  const senderWallets = config.privateKeys.map(privateKey => new ethers.Wallet(privateKey, provider));
  const decryptWallets = config.decryptPrivateKeys.map(privateKey => new ethers.Wallet(privateKey, provider));
  const addressPairs = selectActiveAddressPairs(buildAddressPairs(
    senderWallets.map(wallet => wallet.address),
    config.recipientAddresses
  ), plannedTransferCount(config));

  const pairs: RuntimePair[] = await Promise.all(addressPairs.map(async addressPair => {
    const wallet = senderWallets[addressPair.id - 1];
    return {
      ...addressPair,
      wallet,
      contract: new ethers.Contract(config.tokenAddress, PUSDCTokenV2_1_ABI, wallet),
      nonce: await provider.getTransactionCount(wallet.address, "pending"),
    };
  }));

  const { totalFee } = await estimateFheFee(config.tokenAddress, "transfer", { chainId, verbose: 0 });
  const transferValue = config.transferValue
    ? ethers.parseEther(config.transferValue)
    : BigInt(totalFee);

  return {
    config,
    provider,
    controllerWallet,
    controllerContract,
    settlementContract,
    pairs,
    decryptWallets,
    chainId,
    decimals,
    amountUnits,
    totalFee: transferValue,
  };
}

export function selectActiveAddressPairs(addressPairs: AddressPair[], plannedTxCount: number): AddressPair[] {
  if (plannedTxCount <= 0) return [];
  return addressPairs.slice(0, Math.min(plannedTxCount, addressPairs.length));
}

export async function ensureControllerWhitelisted(runtime: BenchmarkRuntime) {
  const whitelistAddress = runtime.config?.whitelistAddress;
  if (whitelistAddress) {
    const whitelistContract = new ethers.Contract(whitelistAddress, WHITELIST_ABI, runtime.provider);
    const accountHash = addressWhitelistKey(runtime.controllerWallet.address);
    const isWhitelisted: boolean = await whitelistContract.verifyWhitelisted(accountHash);
    if (!isWhitelisted) {
      throw new Error(`Controller wallet is not whitelisted: ${runtime.controllerWallet.address}`);
    }
    return false;
  }

  const isWhitelisted: boolean = await runtime.controllerContract.isWhitelisted(runtime.controllerWallet.address);
  if (isWhitelisted) return false;

  const tx = await runtime.controllerContract.addToWhitelist(runtime.controllerWallet.address);
  await tx.wait();
  return true;
}

export function selectDecryptWallet(address: string, wallets: ethers.Wallet[], fallback: ethers.Wallet): ethers.Wallet {
  const normalized = address.toLowerCase();
  return wallets.find(wallet => wallet.address.toLowerCase() === normalized) || fallback;
}

interface DecryptFailureContext {
  accountAddress: string;
  decryptWalletAddress: string;
  decryptWalletSource: "account" | "controller";
  tokenAddress: string;
  aclAddress: string;
  handle: unknown;
  error: unknown;
}

interface DecryptHandleLogContext {
  accountAddress: string;
  decryptWalletAddress: string;
  decryptWalletSource: "account" | "controller";
  handle: unknown;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "unavailable";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

export function formatDecryptHandleLog(context: DecryptHandleLogContext): string {
  return `[decrypt] handle ` +
    `account=${context.accountAddress} ` +
    `decryptWallet=${context.decryptWalletAddress} ` +
    `source=${context.decryptWalletSource} ` +
    `handle=${formatValue(context.handle)}`;
}

export function formatDecryptFailure(context: DecryptFailureContext): string {
  const error = context.error as any;
  const reason = error?.message ?? String(context.error);
  return `[decrypt] failed ` +
    `account=${context.accountAddress} ` +
    `decryptWallet=${context.decryptWalletAddress} ` +
    `source=${context.decryptWalletSource} ` +
    `token=${context.tokenAddress} ` +
    `acl=${context.aclAddress} ` +
    `handle=${formatValue(context.handle)}: ${reason}`;
}

export function isDecryptPendingError(error: unknown): boolean {
  const message = (error as any)?.message ?? String(error);
  return (
    (message.includes('"code":404') && message.includes("decryption is not available")) ||
    (message.includes('"code":500') && message.includes("no rows returned")) ||
    message.includes("DEADLINE_EXCEEDED")
  );
}

export function isStaleDecryptClientError(error: unknown): boolean {
  const grpcCode = (error as any)?.code;
  const message = (error as any)?.message ?? String(error);
  return grpcCode === grpc.status.UNAVAILABLE || message.includes("UNAVAILABLE");
}

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex.replace(/^0x/i, ""), "hex");
}

function normalizeGrpcTarget(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.host;
  } catch {
    // grpc-js also accepts opaque targets, for example dns:///host:port.
  }
  return rawUrl;
}

function grpcCredentials(rawUrl: string): grpc.ChannelCredentials {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "https:") return grpc.credentials.createSsl();
  } catch {
    // Opaque targets default to insecure h2c.
  }
  return grpc.credentials.createInsecure();
}

function getDecryptClient(rawUrl: string): DecryptionServiceClient {
  const target = normalizeGrpcTarget(rawUrl);
  const cacheKey = `${target}|${rawUrl.startsWith("https://") ? "tls" : "insecure"}`;
  if (decryptClientCache && decryptClientCacheKey === cacheKey) return decryptClientCache;

  const packageDef = protoLoader.loadSync(DECRYPTION_PROTO_PATH);
  const loaded = grpc.loadPackageDefinition(packageDef) as any;
  decryptClientCache = new loaded.decryption.DecryptionService(
    target,
    grpcCredentials(rawUrl),
    {
      "grpc.keepalive_time_ms": 30_000,
      "grpc.keepalive_timeout_ms": 10_000,
      "grpc.keepalive_permit_without_calls": 1,
      "grpc.max_reconnect_backoff_ms": 5_000,
      "grpc.initial_reconnect_backoff_ms": 1_000,
    }
  ) as DecryptionServiceClient;
  decryptClientCacheKey = cacheKey;
  return decryptClientCache;
}

function evictDecryptClient(rawUrl: string): void {
  const target = normalizeGrpcTarget(rawUrl);
  const cacheKey = `${target}|${rawUrl.startsWith("https://") ? "tls" : "insecure"}`;
  if (decryptClientCache && decryptClientCacheKey === cacheKey) {
    decryptClientCache.close();
    decryptClientCache = undefined;
    decryptClientCacheKey = "";
  }
}

export function buildDecryptPayload(
  wallet: ethers.Wallet,
  aclAddress: string,
  handle: string,
  timestamp: number
) {
  const handleBytes = hexToBuffer(handle);
  const handleHex = handleBytes.toString("hex");
  const fheTypeHex = handleHex.slice(60, 62);
  const timestampHex = timestamp.toString(16).padStart(16, "0");
  const messageBytes = ethers.concat([
    handleBytes,
    hexToBuffer(fheTypeHex),
    hexToBuffer(wallet.address),
    hexToBuffer(aclAddress),
    hexToBuffer(timestampHex),
  ]);
  const digest = ethers.keccak256(messageBytes);
  const signature = ethers.Signature.from(wallet.signingKey.sign(digest)).serialized;

  return {
    handle: `0x${handleHex}`,
    valueType: `0x${fheTypeHex}`,
    userAddress: wallet.address,
    aclContractAddress: aclAddress,
    signature,
    timestamp: `0x${timestampHex}`,
  };
}

export async function decryptViaGrpcBridge(
  wallet: ethers.Wallet,
  aclAddress: string,
  handle: string,
  config: BenchmarkConfig
): Promise<bigint> {
  if (BigInt(handle) === 0n) return 0n;

  const decryptionRpcUrl = process.env.DECRYPTION_RPC_URL?.trim();
  const alphaTrionRpcUrl = process.env.ALPHA_TRION_RPC_URL?.trim();
  if (!decryptionRpcUrl) throw new Error("Missing DECRYPTION_RPC_URL");
  if (!alphaTrionRpcUrl) throw new Error("Missing ALPHA_TRION_RPC_URL");

  const startedAt = Date.now();
  let attempts = 0;
  let response: GrpcDecryptResponse | undefined;

  while (!response) {
    attempts++;
    try {
      const remainingMs = Math.max(1, config.decryptTimeoutMs - (Date.now() - startedAt));
      const payload = buildDecryptPayload(wallet, aclAddress, handle, Date.now());
      const client = getDecryptClient(decryptionRpcUrl);
      response = await new Promise<GrpcDecryptResponse>((resolve, reject) => {
        client.DecryptHandle(
          {
            ciphertext: {
              queryParams: JSON.stringify([payload]),
              queryUrl: alphaTrionRpcUrl,
              queryMethod: "query_for_decryption",
            },
          },
          { deadline: new Date(Date.now() + remainingMs) },
          (error, result) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(result || {});
          }
        );
      });
    } catch (error: any) {
      const elapsedMs = Date.now() - startedAt;
      if (isStaleDecryptClientError(error) && elapsedMs < config.decryptTimeoutMs) {
        evictDecryptClient(decryptionRpcUrl);
        await sleep(Math.min(1000, config.decryptTimeoutMs - elapsedMs));
        continue;
      }
      if (!isDecryptPendingError(error) || elapsedMs >= config.decryptTimeoutMs) {
        if (isDecryptPendingError(error) && attempts > 1) {
          throw new Error(`decrypt pending after ${attempts} attempts: ${error?.message ?? error}`);
        }
        throw error;
      }
      await sleep(Math.min(1000, config.decryptTimeoutMs - elapsedMs));
    }
  }

  const plaintext = response.plaintexts?.[0]?.plaintext;
  if (!plaintext || plaintext.length <= 2) throw new Error("DecryptHandle response missing plaintext");
  return BigInt(plaintext);
}

export async function getDecryptedBalanceUnits(
  runtime: BenchmarkRuntime,
  config: BenchmarkConfig,
  address: string
): Promise<bigint | null> {
  const decryptWallet = selectDecryptWallet(
    address,
    runtime.decryptWallets,
    runtime.controllerWallet
  );
  const decryptWalletSource = decryptWallet.address.toLowerCase() === address.toLowerCase()
    ? "account"
    : "controller";
  let handle: string | undefined;

  try {
    handle = String(await runtime.controllerContract.balanceOf(address));
    console.log(formatDecryptHandleLog({
      accountAddress: address,
      decryptWalletAddress: decryptWallet.address,
      decryptWalletSource,
      handle,
    }));
    if (process.env.DECRYPTION_RPC_URL) {
      return await decryptViaGrpcBridge(decryptWallet, config.aclAddress, handle, config);
    }
    const plain = await withTimeout(
      requestDecrypt(
        decryptWallet,
        config.aclAddress,
        FheType.ve_uint256,
        handle
      ),
      config.decryptTimeoutMs,
      `decrypt timeout after ${config.decryptTimeoutMs}ms`
    );

    return BigInt(plain as bigint);
  } catch (error: any) {
    console.warn(formatDecryptFailure({
      accountAddress: address,
      decryptWalletAddress: decryptWallet.address,
      decryptWalletSource,
      tokenAddress: config.tokenAddress,
      aclAddress: config.aclAddress,
      handle,
      error,
    }));
    return null;
  }
}

export async function encryptTransferAmount(
  runtime: BenchmarkRuntime,
  config: BenchmarkConfig,
  pair: RuntimePair,
  id: number
): Promise<PreparedTransfer> {
  const startedAt = Date.now();
  const amountHandle = await requestEncrypt(
    pair.wallet,
    config.aclAddress,
    runtime.amountUnits,
    FheType.ve_uint256,
    runtime.chainId,
    null
  );
  const encryptedAt = Date.now();

  return {
    id,
    pairId: pair.id,
    recipientAddress: pair.recipientAddress,
    amountHandle,
    encryptedAt,
    encryptionMs: encryptedAt - startedAt,
  };
}

export async function sendPreparedTransfer(
  runtime: BenchmarkRuntime,
  pair: RuntimePair,
  prepared: PreparedTransfer
): Promise<ethers.TransactionResponse> {
  const tx = await pair.contract.transfer(
    prepared.recipientAddress,
    prepared.amountHandle,
    { value: runtime.totalFee, nonce: pair.nonce }
  );
  pair.nonce++;
  return tx;
}
