#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPermitTypedData,
  isTransientRpcError,
  mergeEnv,
  parseRowsOption,
  redactPrivateKeyArgs,
  signPermit,
  verifyPermitSigner,
  sanitizeCommandError,
} from "../src/batch-whitelist-approve-deposit";

const rootDir = join(__dirname, "..");

function testPackageExposesBatchWhitelistDepositCommand() {
  const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.equal(
    packageJson.scripts?.["batch:whitelist-deposit"],
    "npx tsx src/batch-whitelist-approve-deposit.ts"
  );
}

function testHelpUsesRunnableSourcePath() {
  const source = readFileSync(join(rootDir, "src/batch-whitelist-approve-deposit.ts"), "utf8");

  assert.match(source, /pnpm exec tsx src\/batch-whitelist-approve-deposit\.ts <command> \[options\]/);
  assert.doesNotMatch(source, /pnpm exec tsx scripts\/batch-whitelist-approve-deposit\.ts/);
}

function testRedactsPrivateKeysFromCommandErrors() {
  const privateKey = `0x${"12".repeat(32)}`;
  const message = sanitizeCommandError(`Command failed: cast send --private-key ${privateKey} 0xabc`);

  assert(!message.includes(privateKey));
  assert(message.includes("--private-key <redacted>"));
}

function testRedactsPrivateKeyArgsForDryRun() {
  assert.deepEqual(redactPrivateKeyArgs(["send", "--private-key", `0x${"12".repeat(32)}`, "--json"]), [
    "send",
    "--private-key",
    "<redacted>",
    "--json",
  ]);
}

function testRuntimeEnvOverridesEnvFileValues() {
  assert.deepEqual(
    mergeEnv({ PRIVATE_KEY: "", RPC_URL: "https://old.example" }, { PRIVATE_KEY: "0xabc" }),
    { PRIVATE_KEY: "0xabc", RPC_URL: "https://old.example" }
  );
}

function testParsesExplicitRowsForBatchPermit() {
  assert.deepEqual(parseRowsOption("1901,1913,1936"), [1901, 1913, 1936]);
  assert.throws(() => parseRowsOption("1901,abc"), /Invalid --rows value/);
}

function testPermitContextReadsTokenVersion() {
  const source = readFileSync(join(rootDir, "src/batch-whitelist-approve-deposit.ts"), "utf8");

  assert.match(source, /version\(\)\(string\)/);
  assert.match(source, /tokenVersion/);
  assert.match(source, /version:\s*context\.tokenVersion/);
}

async function testBuildsVerifiablePermitSignature() {
  const privateKey = `0x${"11".repeat(32)}` as `0x${string}`;
  const owner = "0x19E7E376E7C213B7E7E7E46CC70A5DD086DAFF2A" as `0x${string}`;
  const permit = buildPermitTypedData({
    tokenName: "Mock USDC",
    tokenAddress: "0x0000000000000000000000000000000000000001",
    chainId: 133,
    owner,
    spender: "0x0000000000000000000000000000000000000002",
    value: 100000000n,
    nonce: 7n,
    deadline: 1234567890n,
  });
  const signature = await signPermit(privateKey, permit);

  assert.equal(verifyPermitSigner(permit, signature).toLowerCase(), owner.toLowerCase());
}

function testClassifiesTransientRpcErrors() {
  assert.equal(isTransientRpcError(new Error("HTTP error 502 with body")), true);
  assert.equal(isTransientRpcError(new Error("transaction was not confirmed within the timeout")), true);
  assert.equal(isTransientRpcError(new Error("server returned an error response: error code -32000: already known")), true);
  assert.equal(isTransientRpcError(new Error("USDC balance below deposit amount: 0")), false);
}

async function main() {
  testPackageExposesBatchWhitelistDepositCommand();
  testHelpUsesRunnableSourcePath();
  testRedactsPrivateKeysFromCommandErrors();
  testRedactsPrivateKeyArgsForDryRun();
  testRuntimeEnvOverridesEnvFileValues();
  testParsesExplicitRowsForBatchPermit();
  testPermitContextReadsTokenVersion();
  await testBuildsVerifiablePermitSignature();
  testClassifiesTransientRpcErrors();

  console.log("batch whitelist approve deposit unit tests passed");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
