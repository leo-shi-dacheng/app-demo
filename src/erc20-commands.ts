// cli/common-erc20-cli.ts
import { Command } from "commander";
import type { Erc20Token, EncryptedErc20Token, PrivyTokenWithWhiteList, PrivyTokenWithWhiteListAndDeposit } from "./token";
import { ethers as EthersT } from "ethers";

type TransferAnalysis = {
  txHash: string;
  blockNumber: number;
  from: string;
  to: string;
  amount: { handle: string; formatted?: string; error?: string };
  beforeSender: { handle: string; formatted?: string; error?: string };
  afterSender: { handle: string; formatted?: string; error?: string };
  beforeReceiver: { handle: string; formatted?: string; error?: string };
  afterReceiver: { handle: string; formatted?: string; error?: string };
  formattedSenderDelta?: string;
  formattedReceiverDelta?: string;
};

type EncryptedUSDCToken = PrivyTokenWithWhiteListAndDeposit & {
  addRegulator(account: string): Promise<unknown>;
  removeRegulator(account: string): Promise<unknown>;
  isRegulator(account: string): Promise<{ isRegulator: boolean }>;
  getRegulators(): Promise<{ regulators: string[] }>;
  ensureDecryptAccess(handle: string): Promise<unknown>;
  analyzeTransfer(txHash: string): Promise<TransferAnalysis>;
};

export function registerErc20TokenCommands(program: Command, token: Erc20Token) {
  program.option("--feeValue <value>", "fee value", "0");
  program.option("--feeDecimals <number>", "fee decimals", "18");
  program.hook("preAction", (cmd) => {
    const opts = cmd.opts();
    const feeValue = opts.feeValue ?? "0";
    const feeDecimals = Number(opts.feeDecimals ?? 18);
    token.feeValue = EthersT.parseUnits(feeValue, feeDecimals);
  });

  program
    .command("name")
    .description("Returns the name of the token.")
    .action(async (_opts) => {
      console.log("Token name:", await token.name());
    });

  program
    .command("symbol")
    .description("Returns the symbol of the token, a shorter version of the name.")
    .action(async (_opts) => {
      console.log("Token symbol:", await token.symbol());
    });

  program
    .command("decimals")
    .description("Returns the number of decimals used to get its user representation.")
    .action(async (_opts) => {
      console.log("Token decimals:", await token.decimals());
    });

  program
    .command("totalSupply")
    .description("Returns the value of tokens in existence.")
    .action(async (_opts) => {
      const { totalSupplyHandle, totalSupply, formattedtotalSupply } = await token.totalSupply();
      console.log(`totalSupply: ${formattedtotalSupply}(${totalSupply})` + (token.showHandle ? ` handle: ${totalSupplyHandle}` : ""));
    });

  program
    .command("balanceOf")
    .description("Returns the value of tokens owned by `account`.")
    .option("-a, --account <address>", "Account address")
    .action(async (opts) => {
      const target = opts.account || (await token.signer?.getAddress());
      const { balanceHandle, balance, formattedBalance } = await token.balanceOf(target);
      console.log(`Balance of ${target}: ${formattedBalance}(${balance})` + (token.showHandle ? ` handle: ${balanceHandle}` : ""));
    });

  program
    .command("allowance")
    .description("Returns the remaining number of tokens that `spender` will be allowed to spend on behalf of `owner` through {transferFrom}.")
    .requiredOption("-o, --owner <address>", "Owner address")
    .requiredOption("-s, --spender <address>", "Spender address")
    .action(async (opts) => {
      const { allowanceHandle, allowance, formattedAllowance } = await token.allowance(opts.owner, opts.spender);
      console.log(`Allowance: ${formattedAllowance}(${allowance})` + (token.showHandle ? ` handle: ${allowanceHandle}` : ""));
    });

  program
    .command("mint")
    .description("Creates a value `amount` of tokens and assigns them to msg.sender, by transferring it from address(0).")
    .requiredOption("-a, --amount <value>", "Token amount (human-readable)")
    .action(async (opts) => {
      const owner = await token.signer?.getAddress();
      if (owner) {
        await token.mint(owner, opts.amount);
      } else {
        console.error("cannot get the signer address");
      }
    });

  program
    .command("burn")
    .requiredOption("-a, --amount <value>", "Token amount (human-readable)")
    .description("Destroys a value `amount` of tokens from msg.sender, lowering the balance of msg.sender and the total supply.")
    .action(async (opts) => {
      const owner = await token.signer?.getAddress();
      if (owner) {
        await token.burn(owner, opts.amount);
      } else {
        console.error("cannot get the signer address");
      }
    });

  program
    .command("transfer")
    .description("Moves a value `amount` of tokens from the caller's account to `to`.")
    .requiredOption("-t, --to <address>", "Recipient address")
    .requiredOption("-a, --amount <value>", "Token amount (human-readable)")
    .action(async (opts) => {
      await token.transfer(opts.to, opts.amount);
    });

  program
    .command("approve")
    .description("Sets a value `amount` of tokens as the allowance of `spender` over the caller's tokens.")
    .requiredOption("-s, --spender <address>", "Spender address")
    .requiredOption("-a, --amount <value>", "Token amount (human-readable)")
    .action(async (opts) => {
      await token.approve(opts.spender, opts.amount);
    });

  program
    .command("transferFrom")
    .description("Moves a value `amount` of tokens from `from` to `to` using the allowance mechanism. `value` is then deducted from the caller's allowance.")
    .requiredOption("-f, --from <address>", "Sender address")
    .requiredOption("-t, --to <address>", "Recipient address")
    .requiredOption("-a, --amount <value>", "Token amount (human-readable)")
    .action(async (opts) => {
      await token.transferFrom(opts.from, opts.to, opts.amount);
    });
}

export function registerEncryptedErc20TokenCommands(program: Command, token: EncryptedErc20Token) {
  registerErc20TokenCommands(program, token);
  program
    .command("encrypt")
    .description("Generates a real encrypted payload handle using the FHE SDK.")
    .option("--input <value>", "Plaintext integer in token base units")
    .option("-a, --amount <value>", "Token amount in human-readable units")
    .action(async (opts) => {
      if ((opts.input && opts.amount) || (!opts.input && !opts.amount)) {
        throw new Error("Provide exactly one of --input or --amount");
      }

      const result = opts.amount
        ? await token.encryptAmount(opts.amount)
        : await token.encryptPlaintext(opts.input);
      console.log("Encrypted handle:", result.handle);
    });

  program
    .command("allowForDecryption")
    .description("Grants decryption permission for the `handle` to the specified `account`. If no `account` is provided, the `handle` will be decryptable by anyone.")
    .requiredOption("-h, --handle <value>", "Ciphertext handle(bytes32)")
    .option("-a, --account <address>", "The account to grant decryption permission to")
    .action(async (opts) => {
      const tx = await token.allowForDecryption(opts.handle, opts.account);
    });

  program
    .command("userDecrypt")
    .description("Retrieves the plaintext corresponding to the `handle`.")
    .requiredOption("-h, --handle <value>", "Ciphertext handle(bytes32)")
    .action(async (opts) => {
      const value = await token.userDecrypt(opts.handle);
      console.log(`Decrypted of ${opts.handle}:`, value);
    });
}

export function registerPrivyTokenWithWhiteListCommands(program: Command, token: PrivyTokenWithWhiteList) {
  registerEncryptedErc20TokenCommands(program, token);
  program
    .command("transferOwnership")
    .description("Transfers the contract ownership to `to`.")
    .requiredOption("-t, --to <address>", "The account of new owner")
    .action(async (opts) => {
      await token.transferOwnership(opts.to);
    });

  program
    .command("addToWhitelist")
    .description("Adds an `account` to the whitelist.")
    .requiredOption("-a, --account <address>", "The account to add to whitelist")
    .action(async (opts) => {
      await token.addToWhitelist(opts.account);
    });

  program
    .command("removeFromWhitelist")
    .description("Removes an `account` from the whitelist.")
    .requiredOption("-a, --account <address>", "The account to remove from whitelist")
    .action(async (opts) => {
      await token.removeFromWhitelist(opts.account);
    });

  program
    .command("isWhitelisted")
    .description("Determines whether the `account` is on the whitelist.")
    .requiredOption("-a, --account <address>", "The account address")
    .action(async (opts) => {
      const { isWhitelisted } = await token.isWhitelisted(opts.account);
      console.log(`Is Whitelisted of ${opts.account}: ${isWhitelisted}`);
    });

  program
    .command("getFullWhitelist")
    .description("Retrieves the whitelist.")
    .action(async (_opts) => {
      const { fullWhitelist } = await token.getFullWhitelist();
      console.log("Full whitelists:\n", fullWhitelist);
    });

  program
    .command("getTotalHandles")
    .description("Retrieves all handles for contract status variables, including historical values.")
    .action(async (_opts) => {
      const { totalHandles } = await token.getTotalHandles();
      console.log("Full handles:\n", totalHandles);
    });
}

export function registerPrivyTokenWithWhiteListAndDepositCommands(program: Command, token: PrivyTokenWithWhiteListAndDeposit) {
  registerPrivyTokenWithWhiteListCommands(program, token);

  program
    .command("deposit")
    .description("Deposit a `amount` amount of tokens from erc20 to contract")
    .requiredOption("-a, --amount <amount>", "Amount to deposit")
    .action(async (opts) => {
      await token.deposit(opts.amount);
    });

  program
    .command("claim")
    .description("Claim a `amount` amount of tokens to `to`")
    .requiredOption("-t, --to <address>", "Recipient address")
    .requiredOption("-a, --amount <amount>", "Amount to claim")
    .action(async (opts) => {
      await token.claim(opts.to, opts.amount);
    });

  program
    .command("addOracle")
    .description("Add a `oracle` (only onwer).")
    .requiredOption("-o, --oracle <address>", "Oracle address")
    .action(async (opts) => {
      await token.addOracle(opts.oracle);
    });

  program
    .command("removeOracle")
    .description("Remove a `oracle` (only onwer).")
    .requiredOption("-o, --oracle <address>", "Oracle address")
    .action(async (opts) => {
      await token.removeOracle(opts.oracle);
    });
}

export function registerEncryptedUSDCTokenCommands(program: Command, token: EncryptedUSDCToken) {
  registerEncryptedErc20TokenCommands(program, token);

  program
    .command("transferOwnership")
    .description("Transfers the contract ownership to `to`.")
    .requiredOption("-t, --to <address>", "The account of new owner")
    .action(async (opts) => {
      await token.transferOwnership(opts.to);
    });

  program
    .command("addRegulator")
    .description("Adds an `account` to the regulator role.")
    .requiredOption("-a, --account <address>", "The account to add as regulator")
    .action(async (opts) => {
      await token.addRegulator(opts.account);
    });

  program
    .command("removeRegulator")
    .description("Removes an `account` from the regulator role.")
    .requiredOption("-a, --account <address>", "The account to remove from regulator")
    .action(async (opts) => {
      await token.removeRegulator(opts.account);
    });

  program
    .command("isRegulator")
    .description("Determines whether the `account` is a regulator.")
    .requiredOption("-a, --account <address>", "The account address")
    .action(async (opts) => {
      const { isRegulator } = await token.isRegulator(opts.account);
      console.log(`Is Regulator of ${opts.account}: ${isRegulator}`);
    });

  program
    .command("getRegulators")
    .description("Retrieves all regulator addresses.")
    .action(async (_opts) => {
      const { regulators } = await token.getRegulators();
      console.log("Regulators:\n", regulators);
    });

  program
    .command("getTotalHandles")
    .description("Retrieves all handles for contract status variables, including historical values.")
    .action(async (_opts) => {
      const { totalHandles } = await token.getTotalHandles();
      console.log("Full handles:\n", totalHandles);
    });

  program
    .command("ensureDecryptAccess")
    .description("Ensures the caller has decryption access to the `handle`.")
    .requiredOption("-h, --handle <value>", "Ciphertext handle(bytes32)")
    .action(async (opts) => {
      await token.ensureDecryptAccess(opts.handle);
    });

  program
    .command("analyzeTransfer")
    .description("Analyzes a transfer tx and derives amount plus pre/post balances. Use a regulator signer for the fullest result.")
    .requiredOption("--tx <hash>", "Transfer transaction hash")
    .action(async (opts) => {
      const result = await token.analyzeTransfer(opts.tx);
      console.log(`Transfer tx: ${result.txHash}`);
      console.log(`Block: ${result.blockNumber}`);
      console.log(`From: ${result.from}`);
      console.log(`To: ${result.to}`);
      console.log(`Amount handle: ${result.amount.handle}`);
      console.log(`Amount plaintext: ${result.amount.formatted ?? "N/A"}` + (result.amount.error ? ` (error: ${result.amount.error})` : ""));
      console.log(`Sender balance before: ${result.beforeSender.formatted ?? "N/A"} handle: ${result.beforeSender.handle}` + (result.beforeSender.error ? ` (error: ${result.beforeSender.error})` : ""));
      console.log(`Sender balance after: ${result.afterSender.formatted ?? "N/A"} handle: ${result.afterSender.handle}` + (result.afterSender.error ? ` (error: ${result.afterSender.error})` : ""));
      console.log(`Receiver balance before: ${result.beforeReceiver.formatted ?? "N/A"} handle: ${result.beforeReceiver.handle}` + (result.beforeReceiver.error ? ` (error: ${result.beforeReceiver.error})` : ""));
      console.log(`Receiver balance after: ${result.afterReceiver.formatted ?? "N/A"} handle: ${result.afterReceiver.handle}` + (result.afterReceiver.error ? ` (error: ${result.afterReceiver.error})` : ""));
      console.log(`Derived sender delta: ${result.formattedSenderDelta ?? "N/A"}`);
      console.log(`Derived receiver delta: ${result.formattedReceiverDelta ?? "N/A"}`);
    });

  program
    .command("deposit")
    .description("Deposit a `amount` amount of tokens from erc20 to contract")
    .requiredOption("-a, --amount <amount>", "Amount to deposit")
    .action(async (opts) => {
      await token.deposit(opts.amount);
    });

  program
    .command("claim")
    .description("Claim a `amount` amount of tokens to `to`")
    .requiredOption("-t, --to <address>", "Recipient address")
    .requiredOption("-a, --amount <amount>", "Amount to claim")
    .action(async (opts) => {
      await token.claim(opts.to, opts.amount);
    });

  program
    .command("addOracle")
    .description("Add a `oracle` (only onwer).")
    .requiredOption("-o, --oracle <address>", "Oracle address")
    .action(async (opts) => {
      await token.addOracle(opts.oracle);
    });

  program
    .command("removeOracle")
    .description("Remove a `oracle` (only onwer).")
    .requiredOption("-o, --oracle <address>", "Oracle address")
    .action(async (opts) => {
      await token.removeOracle(opts.oracle);
    });
}
