# Whitelist To eUSDC Deposit Runbook

This runbook uses the TypeScript batch script for the full flow:

1. Configure eUSDC and Whitelist links.
2. Grant Whitelist operator role.
3. Batch add CSV users to Whitelist.
4. Optionally batch fund HSK and USDC through `BatchDistributor`.
5. User-sign USDC approve and eUSDC deposit transactions in parallel.
6. Verify results from onchain events.

Run all commands from the repository root.

> Security note: `whitelist-users.csv` contains user private keys. Keep it local, do not commit it, and do not print private keys in logs.

## 1. Required Environment

`.env` must include:

```bash
RPC_URL=https://testnet02.hashkeychain.net
PRIVATE_KEY=0x...
ADMIN_ADDRESS=0x...
WHITELIST_ADDRESS=0x...
ENCRYPTED_USDC_TOKEN_ADDRESS=0x...
REGULATORY_TOKEN_ADDRESS=0x...
ERC20_ADDRESS=0x...
BATCH_DISTRIBUTOR_ADDRESS=0xCb9a4F02673140cc205B9dA4396e49495E9E8AF9
BATCH_PERMIT_APPROVER_ADDRESS=0x...
DEPOSIT_FROM_BLOCK=27992901
DEPOSIT_WORKERS=8
PERMIT_BATCH_SIZE=100
PERMIT_DEADLINE_SECONDS=86400
RETRY_ATTEMPTS=3
RETRY_DELAY_MS=3000
```

Current deployed `BatchDistributor`:

```bash
BATCH_DISTRIBUTOR_ADDRESS=0xCb9a4F02673140cc205B9dA4396e49495E9E8AF9
```

Deployment transaction:

```bash
0x8efff3d9185a0a35b9f8600555f90552739e55064915f2e93a02d32be641da2d
```

`PRIVATE_KEY` must belong to an address that can configure both contracts:

- eUSDC `owner()` for `setWhitelistContract`.
- Whitelist `DEFAULT_ADMIN_ROLE` for `setRegulatoryTokenContract` and operator grants.
- Whitelist `OPERATOR_ROLE` for `batchAddToWhitelist`.

`whitelist-users.csv` format:

```csv
address,private_key,name,entry_type
```

`entry_type`: `0` individual, `1` institution, `2` other.

## 2. TS Runner

Use the root script:

```bash
pnpm batch:whitelist-deposit -- <command> [options]
```

Equivalent direct command:

```bash
pnpm exec tsx src/batch-whitelist-approve-deposit.ts <command> [options]
```

## 3. Preflight

```bash
pnpm batch:whitelist-deposit -- preflight \
  --csv whitelist-users.csv \
  --row-start 1 \
  --row-end 2000
```

Expected:

- `chain_id=133` for HashKey Chain testnet.
- `admin_from_private_key` equals `ADMIN_ADDRESS`.
- `BATCH_DISTRIBUTOR_ADDRESS` is present.
- `batch_distributor_deployed=true`.

## 4. Deploy BatchDistributor If Needed

This was already deployed and filled:

```bash
BATCH_DISTRIBUTOR_ADDRESS=0xCb9a4F02673140cc205B9dA4396e49495E9E8AF9
```

If a new distributor is needed later:

```bash
pnpm batch:whitelist-deposit -- deploy-distributor
```

The TS script prints `BATCH_DISTRIBUTOR_ADDRESS=0x...` and writes it to `.env` and `.env.example`.

## 4.1 Deploy BatchPermitApprover If Needed

`BatchPermitApprover` submits EIP-2612 `permit` signatures in chunks. It does not hold funds; it only relays user-signed approvals to USDC.

```bash
pnpm batch:whitelist-deposit -- deploy-permit-approver
```

After deployment, set:

```bash
BATCH_PERMIT_APPROVER_ADDRESS=0x...
```

## 5. Configure Contract Links

Set `eUSDC.whitelistContract = WHITELIST_ADDRESS` and `Whitelist.regulatoryTokenContract = REGULATORY_TOKEN_ADDRESS`.

```bash
pnpm batch:whitelist-deposit -- setup-links
```

This command is idempotent and skips transactions when values are already configured.

## 6. Grant Whitelist Operator

Grant `OPERATOR_ROLE` to `ADMIN_ADDRESS`:

```bash
pnpm batch:whitelist-deposit -- grant-operator
```

Grant to a different operator:

```bash
pnpm batch:whitelist-deposit -- grant-operator \
  --operator 0x...
```

## 7. Batch Add Users To Whitelist

```bash
pnpm batch:whitelist-deposit -- whitelist \
  --csv whitelist-users.csv \
  --row-start 1 \
  --row-end 2000 \
  --batch-size 100
```

Log:

```bash
whitelist-batch-add-rows1-2000-transactions.csv
```

Verify:

```bash
pnpm batch:whitelist-deposit -- verify-whitelist \
  --csv whitelist-users.csv \
  --row-start 1 \
  --row-end 2000
```

Expected:

```bash
whitelist_verified=2000/2000
missing_rows=[]
```

## 8. Optional Batch Fund HSK

Users need HSK for gas and eUSDC FHE fee. This command uses `BatchDistributor.distributeNative`.

```bash
pnpm batch:whitelist-deposit -- fund-hsk \
  --csv whitelist-users.csv \
  --row-start 1 \
  --row-end 2000 \
  --batch-size 100 \
  --hsk-amount 20
```

Log:

```bash
hsk-batch-topup-20-rows1-2000-transactions.csv
```

## 9. Optional Batch Fund USDC

This command approves `BatchDistributor` once from `ADMIN_ADDRESS`, then calls `BatchDistributor.distributeERC20`.

```bash
pnpm batch:whitelist-deposit -- fund-usdc \
  --csv whitelist-users.csv \
  --row-start 1 \
  --row-end 2000 \
  --batch-size 100 \
  --usdc-amount 100
```

Log:

```bash
usdc-batch-topup-100-rows1-2000-transactions.csv
```

## 10. Permit Approve USDC

Current USDC supports EIP-2612 `permit`, so approvals can be relayed in batches. Use 100 permits per transaction:

```bash
pnpm batch:whitelist-deposit -- permit-approve \
  --csv whitelist-users.csv \
  --row-start 1 \
  --row-end 2000 \
  --deposit-amount 100 \
  --permit-batch-size 100 \
  --permit-deadline-seconds 86400
```

For a non-contiguous sample, still batch approvals in one `permitMany` transaction by using `--rows`:

```bash
pnpm batch:whitelist-deposit -- permit-approve \
  --csv whitelist-users.csv \
  --rows 1901,1913,1936,1938,1949,1953,1954,1955,1990,1998 \
  --deposit-amount 100 \
  --permit-batch-size 100 \
  --permit-deadline-seconds 86400
```

This approves `ENCRYPTED_USDC_TOKEN_ADDRESS` as spender. It does not deposit eUSDC.

Log:

```bash
permit-usdc-100-rows1-2000-transactions.csv
```

## 11. Deposit eUSDC

`deposit(uint64)` requires:

- User is whitelisted.
- User has enough USDC.
- User approved `ENCRYPTED_USDC_TOKEN_ADDRESS` as USDC spender.
- User has enough HSK for gas and the FHE fee sent as `msg.value`.

`deposit(uint64)` must be signed by each user because eUSDC checks `msg.sender`; it cannot be batched into one admin transaction.

```bash
pnpm batch:whitelist-deposit -- approve-deposit \
  --csv whitelist-users.csv \
  --row-start 1 \
  --row-end 2000 \
  --deposit-amount 100 \
  --deposit-from-block 27992901 \
  --deposit-workers 8 \
  --deposit-msg-value 1ether
```

The script checks existing `Deposit(address,uint64)` events and skips rows that already deposited the same amount after `--deposit-from-block`.

If permit approval has already been completed, skip approval checks and only deposit pending rows:

```bash
pnpm batch:whitelist-deposit -- deposit-only \
  --csv whitelist-users.csv \
  --rows 1901,1913,1936,1938,1949,1953,1954,1955,1990,1998 \
  --deposit-amount 100 \
  --deposit-from-block 27995463 \
  --deposit-workers 8 \
  --deposit-msg-value 1ether
```

Use a fresh `--deposit-from-block` captured immediately before the redeposit test when intentionally depositing the same `--deposit-amount` again. This prevents old `Deposit(address,uint64)` events from making the script skip the new deposit attempt.

For contiguous ranges, use:

```bash
pnpm batch:whitelist-deposit -- deposit-only \
  --csv whitelist-users.csv \
  --row-start 1 \
  --row-end 2000 \
  --deposit-amount 100 \
  --deposit-from-block 27992901 \
  --deposit-workers 8 \
  --deposit-msg-value 1ether
```

Important: current eUSDC only exposes `deposit(uint64)`, which credits `msg.sender`. Therefore deposit cannot be collapsed into one middle-contract transaction while still crediting each user's eUSDC balance. The script keeps one user-signed deposit per user and uses event scans to resume safely.

Logs:

```bash
approve-usdc-100-rows1-2000-transactions.csv
deposit-eusdc-100-rows1-2000-transactions.csv
deposit-errors-100-rows1-2000.csv
```

If you are doing an additional deposit with the same `--deposit-amount`, set `--deposit-from-block` to a block after the previous deposit run.

## 12. Verify Deposits

Verify from onchain `Deposit(address,uint64)` events:

```bash
pnpm batch:whitelist-deposit -- verify-deposit \
  --csv whitelist-users.csv \
  --row-start 1 \
  --row-end 2000 \
  --deposit-amount 100 \
  --deposit-from-block 27992901
```

Expected:

```bash
deposit_success_rows_1_2000=2000/2000
pending_count=0
pending_rows=[]
```

Randomly sample encrypted eUSDC balance handles. This checks `balanceOf(address)(bytes32)` directly and fails if any sampled account returns the zero handle:

```bash
set -a && source .env.hashkey.testnet && set +a
npx tsx <<'TS'
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const csvPath = "whitelist-users.csv";
const sampleSize = 10;
const zeroHandle = `0x${"0".repeat(64)}`;

const [headerLine, ...lines] = readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
const headers = headerLine.split(",").map((header) => header.trim());
const addressIndex = headers.indexOf("address");
if (addressIndex < 0) throw new Error("CSV is missing address column");

const users = lines.filter(Boolean).map((line) => {
  const cells = line.split(",").map((cell) => cell.trim());
  return { address: cells[addressIndex] };
});

const availableRows = Array.from({ length: users.length }, (_, index) => index + 1);
const rows = availableRows
  .sort(() => Math.random() - 0.5)
  .slice(0, Math.min(sampleSize, availableRows.length));

console.log(`sample_rows=${rows.join(" ")}`);

const zeroRows = [];
for (const row of rows) {
  const address = users[row - 1].address;
  const handle = execFileSync(
    "cast",
    [
      "call",
      process.env.ENCRYPTED_USDC_TOKEN_ADDRESS || "",
      "balanceOf(address)(bytes32)",
      address,
      "--rpc-url",
      process.env.RPC_URL || "",
    ],
    { encoding: "utf8" },
  ).trim();
  const nonzero = handle.toLowerCase() !== zeroHandle;
  console.log(`row=${row} address=${address} eusdc_balance_handle=${handle} nonzero=${nonzero}`);
  if (!nonzero) zeroRows.push(row);
}

console.log(`zero_handle_rows=${JSON.stringify(zeroRows)}`);
process.exit(zeroRows.length > 0 ? 1 : 0);
TS
```

Expected:

```bash
zero_handle_rows=[]
```

## 13. One Command Flow

Without funding:

```bash
pnpm batch:whitelist-deposit -- all \
  --csv whitelist-users.csv \
  --row-start 1 \
  --row-end 2000 \
  --batch-size 100 \
  --deposit-amount 100 \
  --deposit-from-block 27992901 \
  --deposit-workers 8 \
  --deposit-msg-value 1ether
```

With HSK and USDC funding:

```bash
pnpm batch:whitelist-deposit -- all \
  --csv whitelist-users.csv \
  --row-start 1 \
  --row-end 2000 \
  --batch-size 100 \
  --hsk-amount 20 \
  --usdc-amount 100 \
  --deposit-amount 100 \
  --deposit-from-block 27992901 \
  --deposit-workers 8 \
  --deposit-msg-value 1ether
```

## 14. Dry Run

```bash
pnpm batch:whitelist-deposit -- all \
  --csv whitelist-users.csv \
  --row-start 1 \
  --row-end 10 \
  --deposit-amount 100 \
  --dry-run
```

## Troubleshooting

- `BATCH_DISTRIBUTOR_ADDRESS is missing`: run `pnpm batch:whitelist-deposit -- deploy-distributor`.
- `EncryptedUSDCToken: whitelist contract not set`: run `setup-links`.
- `EncryptedUSDCToken: address not whitelisted`: run `verify-whitelist`, then rerun `whitelist` for missing rows.
- `ERC20: insufficient balance`: user USDC balance is below `--deposit-amount`.
- Allowance-related `ERC20: insufficient balance`: user did not approve enough USDC to eUSDC; rerun `approve-deposit`.
- `ZeroAmount()` or FHE fee errors: set non-zero `--deposit-msg-value`, for example `1ether`.
- HSK balance errors: run `fund-hsk` or manually top up user HSK.
- Empty deposit verification: set `--deposit-from-block` to a block before the first deposit transaction for this run.
