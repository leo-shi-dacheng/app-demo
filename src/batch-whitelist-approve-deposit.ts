import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { Signature, Wallet, verifyTypedData } from "ethers";

const execFileAsync = promisify(execFile);

const USDC_DECIMALS = 6;
const HSK_DECIMALS = 18;
const MAX_UINT64 = (1n << 64n) - 1n;

type Address = `0x${string}`;
type Hex = `0x${string}`;

type CsvUser = {
  address: Address;
  privateKey?: Hex;
  name: string;
  entryType: number;
};

type Receipt = {
  transactionHash?: string;
  hash?: string;
  status?: string;
  blockNumber?: string | number;
};

type Config = {
  rpcUrl: string;
  privateKey: Hex;
  adminAddress: Address;
  whitelistAddress: Address;
  encryptedUsdcTokenAddress: Address;
  regulatoryTokenAddress: Address;
  erc20Address: Address;
  batchDistributorAddress?: Address;
  batchPermitApproverAddress?: Address;
};

type Cli = {
  command: string;
  csv: string;
  rows?: number[];
  rowStart: number;
  rowEnd?: number;
  batchSize: number;
  depositWorkers: number;
  depositFromBlock: string;
  depositMsgValue: string;
  permitBatchSize: number;
  permitDeadlineSeconds: number;
  retryAttempts: number;
  retryDelayMs: number;
  hskAmount: string;
  usdcAmount: string;
  depositAmount: string;
  operator?: Address;
  dryRun: boolean;
};

type PermitTypedData = {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: {
    Permit: Array<{ name: string; type: string }>;
  };
  value: {
    owner: Address;
    spender: Address;
    value: bigint;
    nonce: bigint;
    deadline: bigint;
  };
};

type PermitSignature = {
  owner: Address;
  spender: Address;
  value: bigint;
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
};

function readEnvFile(path = ".env"): Record<string, string> {
  if (!existsSync(path)) return {};

  const env: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;

    const [key, ...valueParts] = line.split("=");
    env[key.trim()] = valueParts.join("=").trim().replace(/^['"]|['"]$/g, "");
  }
  return env;
}

export function mergeEnv(fileEnv: Record<string, string>, runtimeEnv: NodeJS.ProcessEnv): Record<string, string> {
  const runtime: Record<string, string> = {};
  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (value !== undefined) runtime[key] = value;
  }
  return { ...fileEnv, ...runtime };
}

function writeEnvValue(path: string, key: string, value: string): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  let updated = false;
  const next = lines
    .filter((line, index) => line.length > 0 || index < lines.length - 1)
    .map((line) => {
      if (line.startsWith(`${key}=`)) {
        updated = true;
        return `${key}=${value}`;
      }
      return line;
    });

  if (!updated) {
    if (next.length > 0 && next[next.length - 1].trim()) next.push("");
    next.push(`${key}=${value}`);
  }

  writeFileSync(path, `${next.join("\n")}\n`);
}

function isAddress(value: string | undefined): value is Address {
  return Boolean(value && /^0x[a-fA-F0-9]{40}$/.test(value));
}

function requireAddress(value: string | undefined, name: string): Address {
  if (!isAddress(value)) throw new Error(`${name} is missing or not a valid address`);
  return value as Address;
}

function requirePrivateKey(value: string | undefined, name: string): Hex {
  const normalized = value?.startsWith("0x") ? value : value ? `0x${value}` : undefined;
  if (!normalized || !/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`${name} is missing or not a valid 32-byte private key`);
  }
  return normalized as Hex;
}

export function parseRowsOption(value: string): number[] {
  const rows = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (!/^\d+$/.test(item)) throw new Error(`Invalid --rows value: ${item}`);
      return Number.parseInt(item, 10);
    });
  if (rows.length === 0) throw new Error("--rows must include at least one row number");
  return rows;
}

function parseCli(): Cli {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      csv: { type: "string", default: "whitelist-users.csv" },
      rows: { type: "string" },
      "row-start": { type: "string", default: process.env.ROW_START || "1" },
      "row-end": { type: "string", default: process.env.ROW_END },
      "batch-size": { type: "string", default: process.env.BATCH_SIZE || "100" },
      "deposit-workers": { type: "string", default: process.env.DEPOSIT_WORKERS || "8" },
      "deposit-from-block": { type: "string", default: process.env.DEPOSIT_FROM_BLOCK || "27992901" },
      "deposit-msg-value": { type: "string", default: process.env.DEPOSIT_MSG_VALUE || "1ether" },
      "permit-batch-size": { type: "string", default: process.env.PERMIT_BATCH_SIZE || "100" },
      "permit-deadline-seconds": { type: "string", default: process.env.PERMIT_DEADLINE_SECONDS || "86400" },
      "retry-attempts": { type: "string", default: process.env.RETRY_ATTEMPTS || "3" },
      "retry-delay-ms": { type: "string", default: process.env.RETRY_DELAY_MS || "3000" },
      "hsk-amount": { type: "string", default: process.env.HSK_AMOUNT || "0" },
      "usdc-amount": { type: "string", default: process.env.USDC_AMOUNT || "0" },
      "deposit-amount": { type: "string", default: process.env.DEPOSIT_AMOUNT || "100" },
      operator: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const command = positionals[0] || "help";
  const rowEnd = values["row-end"] ? Number.parseInt(String(values["row-end"]), 10) : undefined;
  const operator = values.operator ? requireAddress(String(values.operator), "--operator") : undefined;

  return {
    command,
    csv: String(values.csv),
    rows: values.rows ? parseRowsOption(String(values.rows)) : undefined,
    rowStart: Number.parseInt(String(values["row-start"]), 10),
    rowEnd,
    batchSize: Number.parseInt(String(values["batch-size"]), 10),
    depositWorkers: Number.parseInt(String(values["deposit-workers"]), 10),
    depositFromBlock: String(values["deposit-from-block"]),
    depositMsgValue: String(values["deposit-msg-value"]),
    permitBatchSize: Number.parseInt(String(values["permit-batch-size"]), 10),
    permitDeadlineSeconds: Number.parseInt(String(values["permit-deadline-seconds"]), 10),
    retryAttempts: Number.parseInt(String(values["retry-attempts"]), 10),
    retryDelayMs: Number.parseInt(String(values["retry-delay-ms"]), 10),
    hskAmount: String(values["hsk-amount"]),
    usdcAmount: String(values["usdc-amount"]),
    depositAmount: String(values["deposit-amount"]),
    operator,
    dryRun: Boolean(values["dry-run"]),
  };
}

function loadConfig(): Config {
  const env = mergeEnv(readEnvFile(".env"), process.env);
  const encryptedUsdcTokenAddress = requireAddress(env.ENCRYPTED_USDC_TOKEN_ADDRESS, "ENCRYPTED_USDC_TOKEN_ADDRESS");

  return {
    rpcUrl: env.RPC_URL || "https://testnet.hsk.xyz",
    privateKey: requirePrivateKey(env.PRIVATE_KEY, "PRIVATE_KEY"),
    adminAddress: requireAddress(env.ADMIN_ADDRESS, "ADMIN_ADDRESS"),
    whitelistAddress: requireAddress(env.WHITELIST_ADDRESS, "WHITELIST_ADDRESS"),
    encryptedUsdcTokenAddress,
    regulatoryTokenAddress: requireAddress(env.REGULATORY_TOKEN_ADDRESS || encryptedUsdcTokenAddress, "REGULATORY_TOKEN_ADDRESS"),
    erc20Address: requireAddress(env.ERC20_ADDRESS, "ERC20_ADDRESS"),
    batchDistributorAddress: isAddress(env.BATCH_DISTRIBUTOR_ADDRESS) ? env.BATCH_DISTRIBUTOR_ADDRESS : undefined,
    batchPermitApproverAddress: isAddress(env.BATCH_PERMIT_APPROVER_ADDRESS) ? env.BATCH_PERMIT_APPROVER_ADDRESS : undefined,
  };
}

function parseCsv(path: string): CsvUser[] {
  const content = readFileSync(path, "utf8").trim();
  const [headerLine, ...lines] = content.split(/\r?\n/);
  const headers = headerLine.split(",").map((header) => header.trim());

  return lines
    .filter(Boolean)
    .map((line, index) => {
      const cells = line.split(",").map((cell) => cell.trim());
      const row = Object.fromEntries(headers.map((header, i) => [header, cells[i] ?? ""]));
      return {
        address: requireAddress(row.address, `${path} row ${index + 2} address`),
        privateKey: row.private_key ? requirePrivateKey(row.private_key, `${path} row ${index + 2} private_key`) : undefined,
        name: row.name || "",
        entryType: Number.parseInt(row.entry_type || "0", 10),
      };
    });
}

function selectedRows(users: CsvUser[], cli: Cli): number[] {
  if (cli.rows) {
    for (const rowNumber of cli.rows) {
      if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > users.length) {
        throw new Error(`--rows value ${rowNumber} must be between 1 and ${users.length}`);
      }
    }
    return cli.rows;
  }

  const rowEnd = cli.rowEnd ?? users.length;
  if (!Number.isInteger(cli.rowStart) || cli.rowStart < 1) throw new Error("--row-start must be >= 1");
  if (!Number.isInteger(rowEnd) || rowEnd < cli.rowStart || rowEnd > users.length) {
    throw new Error(`--row-end must be between ${cli.rowStart} and ${users.length}`);
  }
  return Array.from({ length: rowEnd - cli.rowStart + 1 }, (_, index) => cli.rowStart + index);
}

function parseUnits(value: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`Invalid decimal amount: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`Too many decimal places for ${value}; max ${decimals}`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

function valueToWei(value: string): string {
  if (value.endsWith("ether")) return parseUnits(value.slice(0, -"ether".length), HSK_DECIMALS).toString();
  if (value.endsWith("wei")) return value.slice(0, -"wei".length);
  return parseUnits(value, HSK_DECIMALS).toString();
}

function csvEscape(value: string | number | bigint | undefined): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function appendCsv(path: string, header: string[], row: Array<string | number | bigint | undefined>): void {
  if (!existsSync(path)) appendFileSync(path, `${header.join(",")}\n`);
  appendFileSync(path, `${row.map(csvEscape).join(",")}\n`);
}

export function sanitizeCommandError(message: string): string {
  return message.replace(/(--private-key\s+)(?:0x)?[0-9a-fA-F]{64}/g, "$1<redacted>");
}

export function redactPrivateKeyArgs(args: string[]): string[] {
  return args.map((arg, index) => (args[index - 1] === "--private-key" ? "<redacted>" : arg));
}

export function isTransientRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP error 50[24]\b|error code: 50[24]\b|request timed out|transaction was not confirmed within the timeout|already known/i.test(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(operation: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let lastError: unknown;
  const maxAttempts = Math.max(1, attempts);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientRpcError(error) || attempt === maxAttempts) break;
      await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: process.env,
    });
    return stdout.trim();
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(sanitizeCommandError([err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim()));
  }
}

export function buildPermitTypedData(params: {
  tokenName: string;
  tokenAddress: Address;
  chainId: number;
  owner: Address;
  spender: Address;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
  version?: string;
}): PermitTypedData {
  return {
    domain: {
      name: params.tokenName,
      version: params.version || "1",
      chainId: params.chainId,
      verifyingContract: params.tokenAddress,
    },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    value: {
      owner: params.owner,
      spender: params.spender,
      value: params.value,
      nonce: params.nonce,
      deadline: params.deadline,
    },
  };
}

export async function signPermit(privateKey: Hex, typedData: PermitTypedData): Promise<string> {
  return new Wallet(privateKey).signTypedData(typedData.domain, typedData.types, typedData.value);
}

export function verifyPermitSigner(typedData: PermitTypedData, signature: string): string {
  return verifyTypedData(typedData.domain, typedData.types, typedData.value, signature);
}

async function castCall(config: Config, contract: Address, signature: string, args: string[] = []): Promise<string> {
  return runCommand("cast", ["call", contract, signature, ...args, "--rpc-url", config.rpcUrl]);
}

async function castSend(
  config: Config,
  contract: Address,
  signature: string,
  args: string[],
  options: { valueWei?: string; privateKey?: Hex; dryRun?: boolean } = {},
): Promise<Receipt> {
  const command = [
    "send",
    contract,
    signature,
    ...args,
    "--private-key",
    options.privateKey || config.privateKey,
    "--rpc-url",
    config.rpcUrl,
    "--json",
  ];
  if (options.valueWei) command.push("--value", `${options.valueWei}wei`);

  if (options.dryRun) {
    console.log(`[dry-run] cast ${redactPrivateKeyArgs(command).join(" ")}`);
    return { status: "dry-run" };
  }

  const raw = await runCommand("cast", command);
  return JSON.parse(raw) as Receipt;
}

function receiptTx(receipt: Receipt): string {
  return receipt.transactionHash || receipt.hash || "";
}

function receiptOk(receipt: Receipt): boolean {
  return receipt.status === "0x1" || receipt.status === "success" || receipt.status === "dry-run";
}

async function sendAndRequire(
  label: string,
  config: Config,
  contract: Address,
  signature: string,
  args: string[],
  options: { valueWei?: string; privateKey?: Hex; dryRun?: boolean } = {},
): Promise<Receipt> {
  const receipt = await castSend(config, contract, signature, args, options);
  console.log(`${label}: tx=${receiptTx(receipt)} status=${receipt.status} block=${receipt.blockNumber ?? ""}`);
  if (!receiptOk(receipt)) throw new Error(`${label} failed with status=${receipt.status}`);
  return receipt;
}

async function sendAndRequireWithRetry(
  label: string,
  config: Config,
  cli: Cli,
  contract: Address,
  signature: string,
  args: string[],
  options: { valueWei?: string; privateKey?: Hex; dryRun?: boolean } = {},
): Promise<Receipt> {
  return withRetry(
    () => sendAndRequire(label, config, contract, signature, args, options),
    cli.retryAttempts,
    cli.retryDelayMs,
  );
}

async function hashAddress(address: Address): Promise<Hex> {
  return (await runCommand("cast", ["keccak", `0x${address.toLowerCase().replace("0x", "")}`])) as Hex;
}

function arrayArg(values: string[]): string {
  return `[${values.join(",")}]`;
}

function permitArrayArg(permits: PermitSignature[]): string {
  return `[${permits
    .map((permit) => `(${permit.owner},${permit.spender},${permit.value},${permit.deadline},${permit.v},${permit.r},${permit.s})`)
    .join(",")}]`;
}

function parseCastString(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}

async function loadPermitContext(config: Config): Promise<{ chainId: number; tokenName: string; tokenVersion: string }> {
  await castCall(config, config.erc20Address, "DOMAIN_SEPARATOR()(bytes32)");
  await castCall(config, config.erc20Address, "nonces(address)(uint256)", [config.adminAddress]);
  const chainId = Number(await runCommand("cast", ["chain-id", "--rpc-url", config.rpcUrl]));
  const tokenName = parseCastString(await castCall(config, config.erc20Address, "name()(string)"));
  let tokenVersion = "1";
  try {
    tokenVersion = parseCastString(await castCall(config, config.erc20Address, "version()(string)")) || tokenVersion;
  } catch {
    // Older ERC20Permit deployments commonly hardcode version "1" without exposing a version getter.
  }
  return { chainId, tokenName, tokenVersion };
}

async function buildPermitSignature(config: Config, context: { chainId: number; tokenName: string; tokenVersion: string }, user: CsvUser, amountRaw: bigint, deadline: bigint): Promise<PermitSignature> {
  if (!user.privateKey) throw new Error("private_key missing");
  const nonce = BigInt((await castCall(config, config.erc20Address, "nonces(address)(uint256)", [user.address])).split(/\s+/)[0]);
  const typedData = buildPermitTypedData({
    tokenName: context.tokenName,
    version: context.tokenVersion,
    tokenAddress: config.erc20Address,
    chainId: context.chainId,
    owner: user.address,
    spender: config.encryptedUsdcTokenAddress,
    value: amountRaw,
    nonce,
    deadline,
  });
  const signature = await signPermit(user.privateKey, typedData);
  const signer = verifyPermitSigner(typedData, signature);
  if (signer.toLowerCase() !== user.address.toLowerCase()) throw new Error(`permit signer mismatch: ${signer}`);
  const split = Signature.from(signature);
  return {
    owner: user.address,
    spender: config.encryptedUsdcTokenAddress,
    value: amountRaw,
    deadline,
    v: split.v,
    r: split.r as Hex,
    s: split.s as Hex,
  };
}

async function deployDistributor(config: Config, cli: Cli): Promise<void> {
  if (config.batchDistributorAddress) {
    const code = await runCommand("cast", ["code", config.batchDistributorAddress, "--rpc-url", config.rpcUrl]);
    if (code !== "0x") {
      console.log(`BATCH_DISTRIBUTOR_ADDRESS=${config.batchDistributorAddress}`);
      console.log("BatchDistributor already configured and has deployed bytecode.");
      return;
    }
  }

  if (cli.dryRun) {
    console.log("[dry-run] forge create src/BatchDistributor.sol:BatchDistributor --broadcast");
    return;
  }

  const output = await runCommand(
    "forge",
    [
      "create",
      "src/BatchDistributor.sol:BatchDistributor",
      "--rpc-url",
      config.rpcUrl,
      "--private-key",
      config.privateKey,
      "--broadcast",
    ],
    join(process.cwd(), "packages/whitelist-contract"),
  );
  const match = output.match(/^Deployed to:\s*(0x[a-fA-F0-9]{40})/m);
  if (!match) throw new Error(`Could not parse BatchDistributor deployment output:\n${output}`);

  const address = match[1] as Address;
  writeEnvValue(".env", "BATCH_DISTRIBUTOR_ADDRESS", address);
  writeEnvValue(".env.example", "BATCH_DISTRIBUTOR_ADDRESS", address);
  console.log(output.split(/\r?\n/).filter((line) => /^(Deployer|Deployed to|Transaction hash):/.test(line)).join("\n"));
  console.log(`BATCH_DISTRIBUTOR_ADDRESS=${address}`);
  console.log("Wrote BATCH_DISTRIBUTOR_ADDRESS to .env and .env.example");
}

async function deployPermitApprover(config: Config, cli: Cli): Promise<void> {
  if (config.batchPermitApproverAddress) {
    const code = await runCommand("cast", ["code", config.batchPermitApproverAddress, "--rpc-url", config.rpcUrl]);
    if (code !== "0x") {
      console.log(`BATCH_PERMIT_APPROVER_ADDRESS=${config.batchPermitApproverAddress}`);
      console.log("BatchPermitApprover already configured and has deployed bytecode.");
      return;
    }
  }

  if (cli.dryRun) {
    console.log("[dry-run] forge create src/BatchPermitApprover.sol:BatchPermitApprover --broadcast");
    return;
  }

  const output = await runCommand(
    "forge",
    [
      "create",
      "src/BatchPermitApprover.sol:BatchPermitApprover",
      "--rpc-url",
      config.rpcUrl,
      "--private-key",
      config.privateKey,
      "--broadcast",
    ],
  );
  const match = output.match(/^Deployed to:\s*(0x[a-fA-F0-9]{40})/m);
  if (!match) throw new Error(`Could not parse BatchPermitApprover deployment output:\n${output}`);

  const address = match[1] as Address;
  writeEnvValue(".env", "BATCH_PERMIT_APPROVER_ADDRESS", address);
  writeEnvValue(".env.example", "BATCH_PERMIT_APPROVER_ADDRESS", address);
  console.log(output.split(/\r?\n/).filter((line) => /^(Deployer|Deployed to|Transaction hash):/.test(line)).join("\n"));
  console.log(`BATCH_PERMIT_APPROVER_ADDRESS=${address}`);
  console.log("Wrote BATCH_PERMIT_APPROVER_ADDRESS to .env and .env.example");
}

async function preflight(config: Config, cli: Cli): Promise<void> {
  const users = parseCsv(cli.csv);
  const chainId = await runCommand("cast", ["chain-id", "--rpc-url", config.rpcUrl]);
  const adminFromKey = await runCommand("cast", ["wallet", "address", "--private-key", config.privateKey]);
  const eusdcWhitelist = await castCall(config, config.encryptedUsdcTokenAddress, "whitelistContract()(address)");
  const whitelistRegulatoryToken = await castCall(config, config.whitelistAddress, "regulatoryTokenContract()(address)");
  const distributorCode = config.batchDistributorAddress
    ? await runCommand("cast", ["code", config.batchDistributorAddress, "--rpc-url", config.rpcUrl])
    : "0x";

  console.log(`users=${users.length}`);
  console.log(`chain_id=${chainId}`);
  console.log(`admin_from_private_key=${adminFromKey}`);
  console.log(`configured_admin=${config.adminAddress}`);
  console.log(`eusdc.whitelistContract=${eusdcWhitelist}`);
  console.log(`whitelist.regulatoryTokenContract=${whitelistRegulatoryToken}`);
  console.log(`BATCH_DISTRIBUTOR_ADDRESS=${config.batchDistributorAddress || "<missing>"}`);
  console.log(`batch_distributor_deployed=${distributorCode !== "0x"}`);
  if (config.batchPermitApproverAddress) {
    const permitApproverCode = await runCommand("cast", ["code", config.batchPermitApproverAddress, "--rpc-url", config.rpcUrl]);
    console.log(`BATCH_PERMIT_APPROVER_ADDRESS=${config.batchPermitApproverAddress}`);
    console.log(`batch_permit_approver_deployed=${permitApproverCode !== "0x"}`);
  } else {
    console.log("BATCH_PERMIT_APPROVER_ADDRESS=<missing>");
    console.log("batch_permit_approver_deployed=false");
  }
}

async function setupLinks(config: Config, cli: Cli): Promise<void> {
  const currentWhitelist = await castCall(config, config.encryptedUsdcTokenAddress, "whitelistContract()(address)");
  if (currentWhitelist.toLowerCase() !== config.whitelistAddress.toLowerCase()) {
    await sendAndRequire(
      "setWhitelistContract",
      config,
      config.encryptedUsdcTokenAddress,
      "setWhitelistContract(address)",
      [config.whitelistAddress],
      { dryRun: cli.dryRun },
    );
  } else {
    console.log("setWhitelistContract: already configured");
  }

  const currentRegulatory = await castCall(config, config.whitelistAddress, "regulatoryTokenContract()(address)");
  if (currentRegulatory.toLowerCase() !== config.regulatoryTokenAddress.toLowerCase()) {
    await sendAndRequire(
      "setRegulatoryTokenContract",
      config,
      config.whitelistAddress,
      "setRegulatoryTokenContract(address)",
      [config.regulatoryTokenAddress],
      { dryRun: cli.dryRun },
    );
  } else {
    console.log("setRegulatoryTokenContract: already configured");
  }
}

async function grantOperator(config: Config, cli: Cli): Promise<void> {
  const operator = cli.operator || config.adminAddress;
  const role = await runCommand("cast", ["keccak", "OPERATOR_ROLE"]);
  const hasRole = await castCall(config, config.whitelistAddress, "hasRole(bytes32,address)(bool)", [role, operator]);

  if (hasRole === "true") {
    console.log(`grantOperatorRole: ${operator} already has OPERATOR_ROLE`);
    return;
  }

  await sendAndRequire(
    "grantOperatorRole",
    config,
    config.whitelistAddress,
    "grantOperatorRole(address)",
    [operator],
    { dryRun: cli.dryRun },
  );
}

async function whitelistUsers(config: Config, cli: Cli): Promise<void> {
  const users = parseCsv(cli.csv);
  const rows = selectedRows(users, cli);
  const logPath = `whitelist-batch-add-rows${rows[0]}-${rows[rows.length - 1]}-transactions.csv`;

  for (let offset = 0; offset < rows.length; offset += cli.batchSize) {
    const chunk = rows.slice(offset, offset + cli.batchSize);
    const selected = chunk.map((row) => users[row - 1]);
    const receipt = await sendAndRequire(
      `whitelist rows=${chunk[0]}-${chunk[chunk.length - 1]}`,
      config,
      config.whitelistAddress,
      "batchAddToWhitelist(address[],string[],uint8[])",
      [
        arrayArg(selected.map((user) => user.address)),
        JSON.stringify(selected.map((user) => user.name)),
        arrayArg(selected.map((user) => String(user.entryType))),
      ],
      { dryRun: cli.dryRun },
    );
    appendCsv(
      logPath,
      ["timestamp_utc", "first_row", "last_row", "count", "tx_hash", "status", "block_number"],
      [new Date().toISOString(), chunk[0], chunk[chunk.length - 1], chunk.length, receiptTx(receipt), receipt.status, receipt.blockNumber],
    );
  }
}

async function verifyWhitelist(config: Config, cli: Cli): Promise<void> {
  const users = parseCsv(cli.csv);
  const rows = selectedRows(users, cli);
  const missing: number[] = [];

  for (const rowNumber of rows) {
    const digest = await hashAddress(users[rowNumber - 1].address);
    const ok = await castCall(config, config.whitelistAddress, "verifyWhitelisted(bytes32)(bool)", [digest]);
    if (ok !== "true") missing.push(rowNumber);
  }

  console.log(`whitelist_verified=${rows.length - missing.length}/${rows.length}`);
  console.log(`missing_rows=${JSON.stringify(missing.slice(0, 100))}`);
  if (missing.length > 0) throw new Error("Some rows are not whitelisted");
}

async function fundHsk(config: Config, cli: Cli): Promise<void> {
  const distributor = requireAddress(config.batchDistributorAddress, "BATCH_DISTRIBUTOR_ADDRESS");
  const users = parseCsv(cli.csv);
  const rows = selectedRows(users, cli);
  const amountWei = parseUnits(cli.hskAmount, HSK_DECIMALS);
  if (amountWei <= 0n) throw new Error("--hsk-amount must be greater than 0");
  const logPath = `hsk-batch-topup-${cli.hskAmount}-rows${rows[0]}-${rows[rows.length - 1]}-transactions.csv`;

  for (let offset = 0; offset < rows.length; offset += cli.batchSize) {
    const chunk = rows.slice(offset, offset + cli.batchSize);
    const recipients = chunk.map((row) => users[row - 1].address);
    const receipt = await sendAndRequire(
      `fund-hsk rows=${chunk[0]}-${chunk[chunk.length - 1]}`,
      config,
      distributor,
      "distributeNative(address[],uint256)",
      [arrayArg(recipients), amountWei.toString()],
      { valueWei: (amountWei * BigInt(recipients.length)).toString(), dryRun: cli.dryRun },
    );
    appendCsv(
      logPath,
      ["timestamp_utc", "first_row", "last_row", "count", "amount_hsk", "amount_wei_each", "distributor", "tx_hash", "status", "block_number"],
      [new Date().toISOString(), chunk[0], chunk[chunk.length - 1], chunk.length, cli.hskAmount, amountWei, distributor, receiptTx(receipt), receipt.status, receipt.blockNumber],
    );
  }
}

async function fundUsdc(config: Config, cli: Cli): Promise<void> {
  const distributor = requireAddress(config.batchDistributorAddress, "BATCH_DISTRIBUTOR_ADDRESS");
  const users = parseCsv(cli.csv);
  const rows = selectedRows(users, cli);
  const amountRaw = parseUnits(cli.usdcAmount, USDC_DECIMALS);
  if (amountRaw <= 0n) throw new Error("--usdc-amount must be greater than 0");

  const totalRaw = amountRaw * BigInt(rows.length);
  const allowance = BigInt((await castCall(config, config.erc20Address, "allowance(address,address)(uint256)", [config.adminAddress, distributor])).split(/\s+/)[0]);
  if (allowance < totalRaw) {
    await sendAndRequire(
      "approve BatchDistributor USDC",
      config,
      config.erc20Address,
      "approve(address,uint256)",
      [distributor, totalRaw.toString()],
      { dryRun: cli.dryRun },
    );
  } else {
    console.log("approve BatchDistributor USDC: allowance already sufficient");
  }

  const logPath = `usdc-batch-topup-${cli.usdcAmount}-rows${rows[0]}-${rows[rows.length - 1]}-transactions.csv`;
  for (let offset = 0; offset < rows.length; offset += cli.batchSize) {
    const chunk = rows.slice(offset, offset + cli.batchSize);
    const recipients = chunk.map((row) => users[row - 1].address);
    const receipt = await sendAndRequire(
      `fund-usdc rows=${chunk[0]}-${chunk[chunk.length - 1]}`,
      config,
      distributor,
      "distributeERC20(address,address[],uint256)",
      [config.erc20Address, arrayArg(recipients), amountRaw.toString()],
      { dryRun: cli.dryRun },
    );
    appendCsv(
      logPath,
      ["timestamp_utc", "first_row", "last_row", "count", "amount_display", "amount_raw_each", "token", "distributor", "tx_hash", "status", "block_number"],
      [new Date().toISOString(), chunk[0], chunk[chunk.length - 1], chunk.length, cli.usdcAmount, amountRaw, config.erc20Address, distributor, receiptTx(receipt), receipt.status, receipt.blockNumber],
    );
  }
}

async function permitApproveUsers(config: Config, cli: Cli): Promise<void> {
  const permitApprover = requireAddress(config.batchPermitApproverAddress, "BATCH_PERMIT_APPROVER_ADDRESS");
  const users = parseCsv(cli.csv);
  const rows = selectedRows(users, cli);
  const amountRaw = parseUnits(cli.depositAmount, USDC_DECIMALS);
  if (amountRaw <= 0n) throw new Error("--deposit-amount must be greater than 0");
  if (!Number.isInteger(cli.permitBatchSize) || cli.permitBatchSize < 1) throw new Error("--permit-batch-size must be >= 1");

  const context = await loadPermitContext(config);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + cli.permitDeadlineSeconds);
  const logPath = `permit-usdc-${cli.depositAmount}-rows${rows[0]}-${rows[rows.length - 1]}-transactions.csv`;
  const pending: Array<{ rowNumber: number; permit: PermitSignature }> = [];

  for (const rowNumber of rows) {
    const user = users[rowNumber - 1];
    const allowance = BigInt((await withRetry(
      () => castCall(config, config.erc20Address, "allowance(address,address)(uint256)", [user.address, config.encryptedUsdcTokenAddress]),
      cli.retryAttempts,
      cli.retryDelayMs,
    )).split(/\s+/)[0]);
    if (allowance >= amountRaw) continue;
    const permit = await withRetry(() => buildPermitSignature(config, context, user, amountRaw, deadline), cli.retryAttempts, cli.retryDelayMs);
    pending.push({ rowNumber, permit });
  }

  console.log(`permit_pending=${pending.length}/${rows.length} batch_size=${cli.permitBatchSize}`);
  for (let offset = 0; offset < pending.length; offset += cli.permitBatchSize) {
    const chunk = pending.slice(offset, offset + cli.permitBatchSize);
    const firstRow = chunk[0].rowNumber;
    const lastRow = chunk[chunk.length - 1].rowNumber;
    const receipt = await sendAndRequireWithRetry(
      `permit rows=${firstRow}-${lastRow}`,
      config,
      cli,
      permitApprover,
      "permitMany(address,(address,address,uint256,uint256,uint8,bytes32,bytes32)[])",
      [config.erc20Address, permitArrayArg(chunk.map((item) => item.permit))],
      { dryRun: cli.dryRun },
    );
    appendCsv(
      logPath,
      ["timestamp_utc", "first_row", "last_row", "count", "amount_raw_each", "spender", "tx_hash", "status", "block_number"],
      [new Date().toISOString(), firstRow, lastRow, chunk.length, amountRaw, config.encryptedUsdcTokenAddress, receiptTx(receipt), receipt.status, receipt.blockNumber],
    );
  }
}

async function fetchDepositRows(config: Config, users: CsvUser[], rows: number[], amountRaw: bigint, fromBlock: string): Promise<Set<number>> {
  const raw = await runCommand("cast", [
    "logs",
    "--address",
    config.encryptedUsdcTokenAddress,
    "Deposit(address,uint64)",
    "--from-block",
    fromBlock,
    "--to-block",
    "latest",
    "--rpc-url",
    config.rpcUrl,
    "--json",
    "--query-size",
    "10000",
  ]);
  const logs = raw ? JSON.parse(raw) as Array<{ topics?: string[]; data?: string }> : [];
  const amountHex = amountRaw.toString(16).padStart(64, "0");
  const deposited = new Set(
    logs
      .filter((log) => (log.data || "").toLowerCase().replace("0x", "") === amountHex && (log.topics?.length || 0) > 1)
      .map((log) => `0x${log.topics![1].slice(-40)}`.toLowerCase()),
  );

  return new Set(rows.filter((rowNumber) => deposited.has(users[rowNumber - 1].address.toLowerCase())));
}

async function runWithWorkers<T>(items: T[], workers: number, handler: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const runWorker = async () => {
    while (index < items.length) {
      const item = items[index++];
      await handler(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, runWorker));
}

async function approveDeposit(config: Config, cli: Cli, skipApproval = false): Promise<void> {
  const users = parseCsv(cli.csv);
  const rows = selectedRows(users, cli);
  const amountRaw = parseUnits(cli.depositAmount, USDC_DECIMALS);
  if (amountRaw > MAX_UINT64) throw new Error(`deposit raw amount exceeds uint64: ${amountRaw}`);
  const msgValueWei = valueToWei(cli.depositMsgValue);
  const approveLog = `approve-usdc-${cli.depositAmount}-rows${rows[0]}-${rows[rows.length - 1]}-transactions.csv`;
  const depositLog = `deposit-eusdc-${cli.depositAmount}-rows${rows[0]}-${rows[rows.length - 1]}-transactions.csv`;
  const errorLog = `deposit-errors-${cli.depositAmount}-rows${rows[0]}-${rows[rows.length - 1]}.csv`;

  while (true) {
    const successRows = await fetchDepositRows(config, users, rows, amountRaw, cli.depositFromBlock);
    const pending = rows.filter((rowNumber) => !successRows.has(rowNumber));
    console.log(`deposit_success=${successRows.size}/${rows.length} pending=${pending.length}`);
    if (pending.length === 0) return;

    let ok = 0;
    let failed = 0;
    let transientFailed = 0;
    await runWithWorkers(pending, cli.depositWorkers, async (rowNumber) => {
      const user = users[rowNumber - 1];
      try {
        if (!user.privateKey) throw new Error("private_key missing");

        const balance = BigInt((await withRetry(
          () => castCall(config, config.erc20Address, "balanceOf(address)(uint256)", [user.address]),
          cli.retryAttempts,
          cli.retryDelayMs,
        )).split(/\s+/)[0]);
        if (balance < amountRaw) throw new Error(`USDC balance below deposit amount: ${balance}`);

        if (!skipApproval) {
          const allowance = BigInt((await withRetry(
            () => castCall(config, config.erc20Address, "allowance(address,address)(uint256)", [user.address, config.encryptedUsdcTokenAddress]),
            cli.retryAttempts,
            cli.retryDelayMs,
          )).split(/\s+/)[0]);
          if (allowance < amountRaw) {
            const approval = await sendAndRequireWithRetry(
            `approve row=${rowNumber}`,
            config,
            cli,
            config.erc20Address,
            "approve(address,uint256)",
            [config.encryptedUsdcTokenAddress, amountRaw.toString()],
            { privateKey: user.privateKey, dryRun: cli.dryRun },
            );
            appendCsv(
              approveLog,
              ["timestamp_utc", "row", "address", "amount_display", "amount_raw", "spender", "tx_hash", "status", "block_number"],
              [new Date().toISOString(), rowNumber, user.address, cli.depositAmount, amountRaw, config.encryptedUsdcTokenAddress, receiptTx(approval), approval.status, approval.blockNumber],
            );
          }
        }

        const deposit = await sendAndRequireWithRetry(
          `deposit row=${rowNumber}`,
          config,
          cli,
          config.encryptedUsdcTokenAddress,
          "deposit(uint64)",
          [amountRaw.toString()],
          { privateKey: user.privateKey, valueWei: msgValueWei, dryRun: cli.dryRun },
        );
        appendCsv(
          depositLog,
          ["timestamp_utc", "row", "address", "amount_display", "amount_raw", "token", "msg_value_wei", "tx_hash", "status", "block_number"],
          [new Date().toISOString(), rowNumber, user.address, cli.depositAmount, amountRaw, config.encryptedUsdcTokenAddress, msgValueWei, receiptTx(deposit), deposit.status, deposit.blockNumber],
        );
        ok++;
      } catch (error) {
        failed++;
        if (isTransientRpcError(error)) transientFailed++;
        const message = error instanceof Error ? error.message : String(error);
        appendCsv(errorLog, ["timestamp_utc", "row", "address", "error"], [new Date().toISOString(), rowNumber, user.address, message.replace(/\n/g, " ").slice(0, 1200)]);
        console.log(`deposit error row=${rowNumber}: ${message.slice(0, 240)}`);
      }
      const done = ok + failed;
      if (done === 1 || done === pending.length || done % 100 === 0) {
        console.log(`deposit_parallel_progress done=${done}/${pending.length} ok=${ok} failed=${failed}`);
      }
    });

    if (ok === 0 && transientFailed > 0 && transientFailed === failed) {
      console.log(`all_failed_transient=${failed}; waiting ${cli.retryDelayMs}ms before event rescan`);
      await sleep(cli.retryDelayMs);
      continue;
    }
    if (ok === 0 && failed > 0) throw new Error("No successful deposits in this round; inspect the error log.");
  }
}

async function depositOnly(config: Config, cli: Cli): Promise<void> {
  await approveDeposit(config, cli, true);
}

async function verifyDeposit(config: Config, cli: Cli): Promise<void> {
  const users = parseCsv(cli.csv);
  const rows = selectedRows(users, cli);
  const amountRaw = parseUnits(cli.depositAmount, USDC_DECIMALS);
  const successRows = await fetchDepositRows(config, users, rows, amountRaw, cli.depositFromBlock);
  const pending = rows.filter((rowNumber) => !successRows.has(rowNumber));
  const contractBalance = BigInt((await castCall(config, config.erc20Address, "balanceOf(address)(uint256)", [config.encryptedUsdcTokenAddress])).split(/\s+/)[0]);

  console.log(`deposit_success_rows_${rows[0]}_${rows[rows.length - 1]}=${successRows.size}/${rows.length}`);
  console.log(`pending_count=${pending.length}`);
  console.log(`pending_rows=${JSON.stringify(pending.slice(0, 100))}`);
  console.log(`eusdc_contract_usdc_display=${contractBalance / 10n ** BigInt(USDC_DECIMALS)}`);
  if (pending.length > 0) throw new Error("Some rows have not deposited");
}

async function runAll(config: Config, cli: Cli): Promise<void> {
  await preflight(config, cli);
  await setupLinks(config, cli);
  await grantOperator(config, cli);
  await whitelistUsers(config, cli);
  await verifyWhitelist(config, cli);
  if (parseUnits(cli.hskAmount, HSK_DECIMALS) > 0n) await fundHsk(config, cli);
  if (parseUnits(cli.usdcAmount, USDC_DECIMALS) > 0n) await fundUsdc(config, cli);
  await approveDeposit(config, cli);
  await verifyDeposit(config, cli);
}

function printHelp(): void {
  console.log(`Usage:
  pnpm exec tsx src/batch-whitelist-approve-deposit.ts <command> [options]

Commands:
  deploy-distributor   Deploy BatchDistributor and write BATCH_DISTRIBUTOR_ADDRESS to .env/.env.example
  deploy-permit-approver Deploy BatchPermitApprover and write BATCH_PERMIT_APPROVER_ADDRESS to .env/.env.example
  preflight            Print chain, admin, contract links, and BatchDistributor status
  setup-links          Set eUSDC.whitelistContract and Whitelist.regulatoryTokenContract
  grant-operator       Grant OPERATOR_ROLE to ADMIN_ADDRESS or --operator
  whitelist            Batch add CSV users to Whitelist
  verify-whitelist     Verify CSV rows are whitelisted
  fund-hsk             Batch distribute HSK via BatchDistributor
  fund-usdc            Batch approve/distribute USDC via BatchDistributor
  permit-approve       Batch submit USDC permit approvals via BatchPermitApprover
  approve-deposit      User-signed approve USDC and deposit eUSDC in parallel
  deposit-only         User-signed deposit only; assumes USDC allowance is already set
  verify-deposit       Verify Deposit(address,uint64) events
  all                  Run setup-links, grant-operator, whitelist, verify, optional funding, approve-deposit, verify

Options:
  --csv whitelist-users.csv
  --rows 1901,1913,1936
  --row-start 1 --row-end 2000
  --batch-size 100
  --hsk-amount 20
  --usdc-amount 100
  --deposit-amount 100
  --deposit-from-block 27992901
  --deposit-workers 8
  --deposit-msg-value 1ether
  --permit-batch-size 100
  --permit-deadline-seconds 86400
  --retry-attempts 3
  --retry-delay-ms 3000
  --dry-run`);
}

async function main(): Promise<void> {
  const cli = parseCli();
  if (cli.command === "help" || cli.command === "--help" || cli.command === "-h") {
    printHelp();
    return;
  }

  const config = loadConfig();
  switch (cli.command) {
    case "deploy-distributor":
      await deployDistributor(config, cli);
      break;
    case "deploy-permit-approver":
      await deployPermitApprover(config, cli);
      break;
    case "preflight":
      await preflight(config, cli);
      break;
    case "setup-links":
      await setupLinks(config, cli);
      break;
    case "grant-operator":
      await grantOperator(config, cli);
      break;
    case "whitelist":
      await whitelistUsers(config, cli);
      break;
    case "verify-whitelist":
      await verifyWhitelist(config, cli);
      break;
    case "fund-hsk":
      await fundHsk(config, cli);
      break;
    case "fund-usdc":
      await fundUsdc(config, cli);
      break;
    case "permit-approve":
      await permitApproveUsers(config, cli);
      break;
    case "approve-deposit":
      await approveDeposit(config, cli);
      break;
    case "deposit-only":
      await depositOnly(config, cli);
      break;
    case "verify-deposit":
      await verifyDeposit(config, cli);
      break;
    case "all":
      await runAll(config, cli);
      break;
    default:
      printHelp();
      throw new Error(`Unknown command: ${cli.command}`);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
