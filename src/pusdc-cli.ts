#!/usr/bin/env tsx
import { registerPrivyTokenWithWhiteListAndDepositCommands } from "./erc20-commands";
import { Command } from "commander";
import { PUSDCTokenV2_1 } from "./token";
import { removeCommandIfExists } from "./utils";

export function registerPUSDCCLI(program: Command) {
  const token = new PUSDCTokenV2_1();
  registerPrivyTokenWithWhiteListAndDepositCommands(program, token);

  removeCommandIfExists(program, 'mint');
  removeCommandIfExists(program, 'burn');
  removeCommandIfExists(program, 'bindNativeToExecutor');
  removeCommandIfExists(program, 'releaseNativeFromExecutor');
  removeCommandIfExists(program, 'balanceOfNative');
}

if (require.main === module) {
  const program = new Command();
  registerPUSDCCLI(program);
  program.parseAsync().catch(err => {
    console.error("CLI error:", err);
    process.exit(1);
  });
}
