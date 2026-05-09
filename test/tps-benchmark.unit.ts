#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { Command } from "commander";
import { ethers } from "ethers";
import {
  addressWhitelistKey,
  computeObservedSettlements,
  isTrackerComplete,
  markCompletedByObservedSettlements,
  parseTokenUnits,
} from "./tps/metrics";
import { parseBenchmarkConfig, parseWalletCsv } from "./tps/config";
import { registerEncryptedErc20TokenCommands } from "../src/erc20-commands";
import { buildAddressPairs } from "./tps/wallet-plan";
import { getReportTpsMetricLabels, planRecipientBaselines, planSendWaves } from "./tps/runner";
import {
  buildDecryptPayload,
  formatDecryptFailure,
  formatDecryptHandleLog,
  isDecryptPendingError,
  isStaleDecryptClientError,
  selectDecryptWallet,
} from "./tps/runtime";
import type { TxRecord } from "./tps/types";

const REQUIRED_ENV = {
  RPC_URL: "https://testnet.hsk.xyz",
  PUSDC_TOKEN_ADDRESS: "0x0000000000000000000000000000000000000001",
  ACL_ADDRESS: "0x0000000000000000000000000000000000000002",
  TPS_TX_COUNT: "10",
  TPS_RECIPIENTS: "0x0000000000000000000000000000000000000004",
};
const TEST_HANDLE = `0x${"11".repeat(32)}`;

function tx(overrides: Partial<TxRecord>): TxRecord {
  return {
    id: 1,
    pairId: 1,
    from: "0x0000000000000000000000000000000000000001",
    to: "0x0000000000000000000000000000000000000002",
    txHash: "0x",
    initiatedAt: 1_000,
    ...overrides,
  };
}

function testIntegerTokenParsing() {
  assert.equal(parseTokenUnits("0.000001", 6), 1n);
  assert.equal(parseTokenUnits("1.234567", 6), 1_234_567n);
  assert.equal(parseTokenUnits("1000000000000.000001", 6), 1_000_000_000_000_000_001n);
}

function testObservedSettlementsUseCumulativeBaseline() {
  assert.equal(computeObservedSettlements(1_000n, 1_003n, 1n), 3);
  assert.equal(computeObservedSettlements(1_000n, 1_003n, 2n), 1);
  assert.equal(computeObservedSettlements(1_003n, 1_000n, 1n), 0);
}

function testLateConfirmationsAreMarkedAfterSettlementObserved() {
  const records = [
    tx({ id: 1, onChainAt: undefined }),
    tx({ id: 2, onChainAt: 2_000 }),
  ];

  assert.equal(markCompletedByObservedSettlements(records, 2, 5_000), 0);
  assert.equal(records[0].completedAt, undefined);
  assert.equal(records[1].completedAt, undefined);

  records[0].onChainAt = 2_500;
  assert.equal(markCompletedByObservedSettlements(records, 2, 6_000), 2);
  assert.equal(records[0].completedAt, 6_000);
  assert.equal(records[1].completedAt, 6_000);
}

function testTrackerDoesNotExitBeforeConfirmationsFinish() {
  const records = [
    tx({ id: 1, onChainAt: undefined }),
    tx({ id: 2, onChainAt: undefined }),
  ];

  assert.equal(isTrackerComplete(records, true), false);

  records[0].onChainAt = 2_000;
  records[0].completedAt = 3_000;
  records[1].error = "send failed";

  assert.equal(isTrackerComplete(records, true), true);
}

function testBuildsIndependentAddressPairs() {
  const pairs = buildAddressPairs(
    ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000003"],
    ["0x0000000000000000000000000000000000000002", "0x0000000000000000000000000000000000000004"]
  );

  assert.deepEqual(pairs.map(p => [p.senderAddress, p.recipientAddress]), [
    ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002"],
    ["0x0000000000000000000000000000000000000003", "0x0000000000000000000000000000000000000004"],
  ]);
}

function generatePrivateKeys(count: number): string {
  return Array.from({ length: count }, (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}`).join(",");
}

function generateCsvWallets(count: number): string {
  const rows = Array.from({ length: count }, (_, index) => {
    const address = `0x${(index + 101).toString(16).padStart(40, "0")}`;
    const privateKey = `0x${(index + 1).toString(16).padStart(64, "0")}`;
    return `${address},${privateKey},user-${index + 1},sender`;
  });
  return ["address,private_key,name,entry_type", ...rows].join("\n");
}

function testParsesCsvWalletsAndDerivesWhitelistedRecipients() {
  const wallets = parseWalletCsv(generateCsvWallets(50));

  assert.equal(wallets.privateKeys.length, 25);
  assert.equal(wallets.recipientAddresses.length, 25);
  assert.equal(wallets.decryptPrivateKeys.length, 50);
  assert.equal(wallets.privateKeys[0], `0x${"1".padStart(64, "0")}`);
  assert.equal(wallets.privateKeys[1], `0x${"3".padStart(64, "0")}`);
  assert.equal(wallets.decryptPrivateKeys[1], `0x${"2".padStart(64, "0")}`);
  assert.equal(wallets.recipientAddresses[0], "0x0000000000000000000000000000000000000066");
  assert.equal(wallets.recipientAddresses[1], "0x0000000000000000000000000000000000000068");
  assert.equal(wallets.recipientAddresses[24], "0x0000000000000000000000000000000000000096");
}

function testRejectsMissingRecipientsInsteadOfGeneratingRandomAddresses() {
  assert.throws(
    () =>
      buildAddressPairs(["0x0000000000000000000000000000000000000001"], []),
    /TPS_RECIPIENTS is required/i
  );
}

function testRejectsFewerThanTwentyFiveSenderWallets() {
  assert.throws(
    () =>
      parseBenchmarkConfig({
        ...REQUIRED_ENV,
        TPS_PRIVATE_KEYS: generatePrivateKeys(24),
      }),
    /at least 25 sender wallets/i
  );
}

function testRejectsPrivateKeyOnlyConfig() {
  assert.throws(
    () =>
      parseBenchmarkConfig({
        ...REQUIRED_ENV,
        PRIVATE_KEY: "0xabc",
      }),
    /at least 25 sender wallets/i
  );
}

function testAcceptsFiftyWallets() {
  const config = parseBenchmarkConfig({
    ...REQUIRED_ENV,
    TPS_PRIVATE_KEYS: generatePrivateKeys(50),
    TPS_PRE_ENCRYPT: "true",
    WHITELIST_ADDRESS: "0x0000000000000000000000000000000000000003",
  });

  assert.equal(config.encryptMode, "pre");
  assert.equal(config.completionMode, "balance");
  assert.equal(config.privateKeys.length, 50);
  assert.equal(config.txCount, 10);
  assert.equal(config.whitelistAddress, "0x0000000000000000000000000000000000000003");
}

function testDefaultsBenchmarkAmountToOnePusdc() {
  const config = parseBenchmarkConfig({
    ...REQUIRED_ENV,
    TPS_PRIVATE_KEYS: generatePrivateKeys(50),
  });

  assert.equal(config.amount, "1");
}

function testDefaultsDecryptTimeoutToLongGrpcDeadline() {
  const config = parseBenchmarkConfig({
    ...REQUIRED_ENV,
    TPS_PRIVATE_KEYS: generatePrivateKeys(50),
  });

  assert.equal(config.decryptTimeoutMs, 15_000_000);
}

function testParsesTransferValueOverride() {
  const config = parseBenchmarkConfig({
    ...REQUIRED_ENV,
    TPS_PRIVATE_KEYS: generatePrivateKeys(50),
    TPS_TRANSFER_VALUE: "1",
  });

  assert.equal(config.transferValue, "1");
}

function testRejectsTrivialEncryptionSource() {
  assert.throws(
    () => parseBenchmarkConfig({
      ...REQUIRED_ENV,
      TPS_PRIVATE_KEYS: generatePrivateKeys(50),
      TPS_ENCRYPTION_SOURCE: "trivial",
      FHE_EXECUTOR_ADDRESS: "0x0000000000000000000000000000000000000005",
    }),
    /TPS_ENCRYPTION_SOURCE must be "sdk"/i
  );
}

function testRegistersEncryptCommandForHandleGeneration() {
  const program = new Command();
  registerEncryptedErc20TokenCommands(program, {} as any);

  assert(program.commands.some(command => command.name() === "encrypt"));
}

function testAddressWhitelistKeyMatchesCastKeccakAddress() {
  assert.equal(
    addressWhitelistKey("0x0Ca09db7D955750F1E75e75b5a777CF45aa1017f"),
    "0xe775d3d480c3794b716bc36dd1d892f6ef5c683f2d19158b525382276338395d"
  );
}

function testReportKeepsOnlyOneCompletionTpsMetric() {
  const labels = getReportTpsMetricLabels();

  assert(labels.includes("On-chain TPS"));
  assert(labels.includes("FHE TPS"));
  assert(labels.includes("Effective TPS"));
  assert(!labels.includes("Complete TPS"));
}

function testPlansOneThousandTransfersAsTwentyWalletWaves() {
  const waves = planSendWaves(1000, 50, 50);

  assert.equal(waves.length, 20);
  assert.deepEqual(waves[0], {
    id: 1,
    txIds: Array.from({ length: 50 }, (_, index) => index + 1),
    pairIds: Array.from({ length: 50 }, (_, index) => index + 1),
  });
  assert.deepEqual(waves[19], {
    id: 20,
    txIds: Array.from({ length: 50 }, (_, index) => index + 951),
    pairIds: Array.from({ length: 50 }, (_, index) => index + 1),
  });
}

function testPlansOnlyRecipientsTouchedByPlannedTransfers() {
  const pairs = Array.from({ length: 50 }, (_, index) => ({
    recipientAddress: `0x${(index + 1).toString(16).padStart(40, "0")}`,
  }));

  assert.deepEqual(planRecipientBaselines(pairs, 3), [
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002",
    "0x0000000000000000000000000000000000000003",
  ]);
  assert.equal(planRecipientBaselines(pairs, 100).length, 50);
}

function testRejectsWaveSizeLargerThanPairCount() {
  assert.throws(
    () => planSendWaves(1000, 50, 51),
    /TPS_WAVE_SIZE cannot exceed sender pair count/i
  );
}

function testParsesSendSchedulerConfig() {
  const config = parseBenchmarkConfig({
    ...REQUIRED_ENV,
    TPS_PRIVATE_KEYS: generatePrivateKeys(50),
    TPS_SEND_CONCURRENCY: "25",
    TPS_WAVE_SIZE: "50",
    TPS_WAVE_DELAY: "200",
  });

  assert.equal(config.sendConcurrency, 25);
  assert.equal(config.waveSize, 50);
  assert.equal(config.waveDelayMs, 200);
}

function testSelectsRecipientWalletForBalanceDecrypt() {
  const controller = new ethers.Wallet(`0x${"1".padStart(64, "0")}`);
  const recipient = new ethers.Wallet(`0x${"2".padStart(64, "0")}`);

  const selected = selectDecryptWallet(recipient.address, [recipient], controller);

  assert.equal(selected.address, recipient.address);
}

function testFormatsDecryptHandleLogWithFullHandle() {
  const message = formatDecryptHandleLog({
    accountAddress: "0x71cffec6d7c97fcd0aca68217faa0fc684eb1fb1",
    decryptWalletAddress: "0x71CFFEc6d7C97fCD0ACA68217FAa0Fc684eb1fB1",
    decryptWalletSource: "account",
    handle: TEST_HANDLE,
  });

  assert(message.includes("account=0x71cffec6d7c97fcd0aca68217faa0fc684eb1fb1"));
  assert(message.includes("decryptWallet=0x71CFFEc6d7C97fCD0ACA68217FAa0Fc684eb1fB1"));
  assert(message.includes("source=account"));
  assert(message.includes(`handle=${TEST_HANDLE}`));
}

function testFormatsDecryptFailureWithHandleAndAccountContext() {
  const message = formatDecryptFailure({
    accountAddress: "0x71cffec6d7c97fcd0aca68217faa0fc684eb1fb1",
    decryptWalletAddress: "0x71CFFEc6d7C97fCD0ACA68217FAa0Fc684eb1fB1",
    decryptWalletSource: "account",
    tokenAddress: "0xE1B8a1837089b384F6cf1Bb3440b5E56b1b30493",
    aclAddress: "0xbe7673C903C2255510066f788b65abDEf4674f07",
    handle: TEST_HANDLE,
    error: new Error("14 UNAVAILABLE: No connection established"),
  });

  assert(message.includes("account=0x71cffec6d7c97fcd0aca68217faa0fc684eb1fb1"));
  assert(message.includes("decryptWallet=0x71CFFEc6d7C97fCD0ACA68217FAa0Fc684eb1fB1"));
  assert(message.includes("source=account"));
  assert(message.includes("token=0xE1B8a1837089b384F6cf1Bb3440b5E56b1b30493"));
  assert(message.includes("acl=0xbe7673C903C2255510066f788b65abDEf4674f07"));
  assert(message.includes(`handle=${TEST_HANDLE}`));
  assert(message.includes("14 UNAVAILABLE: No connection established"));
}

function testRecognizesDecryptPending404Error() {
  assert.equal(
    isDecryptPendingError(new Error('13 INTERNAL: {"code":404,"error":"decryption is not available"}')),
    true
  );
  assert.equal(isDecryptPendingError(new Error("4 DEADLINE_EXCEEDED: Deadline exceeded after 0.001s")), true);
  assert.equal(isDecryptPendingError(new Error("14 UNAVAILABLE: No connection established")), false);
}

function testRecognizesStaleGrpcClientError() {
  assert.equal(isStaleDecryptClientError(new Error("14 UNAVAILABLE: No connection established")), true);
  assert.equal(isStaleDecryptClientError(new Error("4 DEADLINE_EXCEEDED: Deadline exceeded")), false);
}

function testBuildsFreshDecryptPayloadForEachTimestamp() {
  const wallet = new ethers.Wallet(`0x${"2".padStart(64, "0")}`);
  const first = buildDecryptPayload(
    wallet,
    "0xbe7673C903C2255510066f788b65abDEf4674f07",
    "0xc8fa7c89ffb79e1d67fe55a6bee074cb8c0ea7c10000000001a29bfb040f0621",
    1_000
  );
  const second = buildDecryptPayload(
    wallet,
    "0xbe7673C903C2255510066f788b65abDEf4674f07",
    "0xc8fa7c89ffb79e1d67fe55a6bee074cb8c0ea7c10000000001a29bfb040f0621",
    2_000
  );

  assert.equal(first.userAddress, wallet.address);
  assert.notEqual(first.timestamp, second.timestamp);
  assert.notEqual(first.signature, second.signature);
}

testIntegerTokenParsing();
testObservedSettlementsUseCumulativeBaseline();
testLateConfirmationsAreMarkedAfterSettlementObserved();
testTrackerDoesNotExitBeforeConfirmationsFinish();
testBuildsIndependentAddressPairs();
testParsesCsvWalletsAndDerivesWhitelistedRecipients();
testRejectsMissingRecipientsInsteadOfGeneratingRandomAddresses();
testRejectsFewerThanTwentyFiveSenderWallets();
testRejectsPrivateKeyOnlyConfig();
testAcceptsFiftyWallets();
testDefaultsBenchmarkAmountToOnePusdc();
testDefaultsDecryptTimeoutToLongGrpcDeadline();
testParsesTransferValueOverride();
testRejectsTrivialEncryptionSource();
testRegistersEncryptCommandForHandleGeneration();
testAddressWhitelistKeyMatchesCastKeccakAddress();
testReportKeepsOnlyOneCompletionTpsMetric();
testPlansOneThousandTransfersAsTwentyWalletWaves();
testPlansOnlyRecipientsTouchedByPlannedTransfers();
testRejectsWaveSizeLargerThanPairCount();
testParsesSendSchedulerConfig();
testSelectsRecipientWalletForBalanceDecrypt();
testFormatsDecryptHandleLogWithFullHandle();
testFormatsDecryptFailureWithHandleAndAccountContext();
testRecognizesDecryptPending404Error();
testRecognizesStaleGrpcClientError();
testBuildsFreshDecryptPayloadForEachTimestamp();

console.log("tps-benchmark unit tests passed");
