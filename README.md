- [Overview](#overview)
- [Configuration](#configuration)
- [Commandline tool](#commandline-tool)
  - [Fist-of-All](#fist-of-all)
    - [addOracle](#addoracle)
    - [removeOracle](#removeoracle)
  - [ERC20](#erc20)
    - [name](#name)
    - [symbol](#symbol)
    - [decimals](#decimals)
    - [totalSupply](#totalsupply)
    - [balance](#balance)
    - [allowance](#allowance)
    - [deposit](#deposit)
    - [claim](#claim)
    - [transfer](#transfer)
    - [approve](#approve)
    - [transferFrom](#transferfrom)
  - [Whitelist](#whitelist)
    - [transferOwnership](#transferownership)
    - [addToWhitelist](#addtowhitelist)
    - [removeFromWhitelist](#removefromwhitelist)
    - [isWhitelisted](#iswhitelisted)
    - [getFullWhitelist](#getfullwhitelist)
    - [getTotalHandles](#gettotalhandles)
  - [Decryption](#decryption)
    - [allowForDecryption](#allowfordecryption)
    - [encrypt](#encrypt)
    - [userDecrypt](#userdecrypt)


## Overview

**Addresses:**

| Contract              | Address                                    | Chain(ID)                  |
| --------------------- | ------------------------------------------ | -------------------------- |
| Encrypted USDC(eUSDC) | 0x50AcA8D550d5531788cdB5873F027784135c3467 | HashKey Chain Testnet(133) |


<br/>

**Encrypted USDC(eUSDC)** is an **FHE-based** token built on the standard ERC20 contract. It supports typical ERC20 functionality such as transferring tokens. Additionally, it supports whitelisting for regulatory purposes.


## Configuration

- Copy `.env.hashkey.testnet` to `.env`.
- Set up your wallet's private key `PRIVATE_KEY`.


## Commandline tool


**This tool consists of three components:**

* ERC20 basic functionality operations
* Whitelist-related operations
* Decryption operations


<br/>


Before using this tool, execute the following command:

```sh
npm install
npm run build
```

**Requirements:**
- node v22+

<br/>


**List all commands**

```sh
npx tsx src/pusdc-cli.ts help
```

```log
Usage: pusdc-cli [options] [command]

Options:
  --feeValue <value>                   fee value (default: "0")
  --feeDecimals <number>               fee decimals (default: "18")
  -h, --help                           display help for command

Commands:
  name                                 Returns the name of the token.
  symbol                               Returns the symbol of the token, a shorter version of the name.
  decimals                             Returns the number of decimals used to get its user representation.
  totalSupply                          Returns the value of tokens in existence.
  balanceOf [options]                  Returns the value of tokens owned by `account`.
  allowance [options]                  Returns the remaining number of tokens that `spender` will be allowed to spend on behalf of `owner` through
                                       {transferFrom}.
  transfer [options]                   Moves a value `amount` of tokens from the caller's account to `to`.
  approve [options]                    Sets a value `amount` of tokens as the allowance of `spender` over the caller's tokens.
  transferFrom [options]               Moves a value `amount` of tokens from `from` to `to` using the allowance mechanism. `value` is then deducted from
                                       the caller's allowance.
  encrypt [options]                    Generates a real encrypted payload handle using the FHE SDK.
  allowForDecryption [options]         Grants decryption permission for the `handle` to the specified `account`. If no `account` is provided, the
                                       `handle` will be decryptable by anyone.
  userDecrypt [options]                Retrieves the plaintext corresponding to the `handle`.
  transferOwnership [options]          Transfers the contract ownership to `to`.
  addToWhitelist [options]             Adds an `account` to the whitelist.
  removeFromWhitelist [options]        Removes an `account` from the whitelist.
  isWhitelisted [options]              Determines whether the `account` is on the whitelist.
  getFullWhitelist                     Retrieves the whitelist.
  getTotalHandles                      Retrieves all handles for contract status variables, including historical values.
  deposit [options]                    Deposit a `amount` amount of tokens from erc20 to contract
  claim [options]                      Claim a `amount` amount of tokens to `to`
  addOracle [options]                  Add a `oracle` (only onwer).
  removeOracle [options]               Remove a `oracle` (only onwer).
  help [command]                       display help for command
```

### Fist-of-All

**Prerequisite**: If you are the contract deployer, you must run `addOracle` before (others) executing any other CLI commands.

#### addOracle

```sh
npx tsx src/pusdc-cli.ts addOracle --oracle <address>
# Options:
#   -o, --oracle <address>  Oracle address
```

Add a `oracle` (only onwer).

#### removeOracle

```sh
npx tsx src/pusdc-cli.ts removeOracle --oracle <address>
# Options:
#   -o, --oracle <address>  Oracle address
```

Remove a `oracle` (only onwer).


### ERC20

#### name

```sh
npx tsx src/pusdc-cli.ts name
```

Returns the name of the token.

e.g.
```
# npx tsx src/pusdc-cli.ts name
Token name: Encrypted USDC Token
```


#### symbol

```sh
npx tsx src/pusdc-cli.ts symbol
```

Returns the symbol of the token, a shorter version of the name.

e.g.
```
# npx tsx src/pusdc-cli.ts symbol
Token symbol: eUSDC
```

#### decimals

```sh
npx tsx src/pusdc-cli.ts decimals
```

Returns the number of decimals used to get its user representation.

e.g.
```
# npx tsx src/pusdc-cli.ts decimals
Token decimals: 6n
```


#### totalSupply

```sh
npx tsx src/pusdc-cli.ts totalSupply
```

Returns the value of tokens in existence.

*Only the contract owner (and users on the whitelist) have the permission to decrypt.*


#### balance

```sh
npx tsx src/pusdc-cli.ts balanceOf --account <address>
# Options:
#   --account <address>  Account address
```

Returns the value of tokens owned by `account`.


*Only the `account` owner (and users on the whitelist) have the permission to decrypt.*


#### allowance

```sh
npx tsx src/pusdc-cli.ts allowance --owner <address> --spender <address>
# Options:
#   --owner <address>    Owner address
#   --spender <address>  Spender address
```

Returns the remaining number of tokens that `spender` will be allowed to spend on behalf of `owner` through **transferFrom**.

*Only the `owner` owner and `spender` owner (and users on the whitelist) have the permission to decrypt.*


#### deposit

**NOTE:** Before **deposit**, you should **approve** some `amount` to **eUSDC Contract** first.

```sh
npx tsx src/oz-cli.ts approve --spender <eUSDC_ADDRESS> --amount <amount>
```


```sh
npx tsx src/pusdc-cli.ts deposit --amount <amount>
# Options:
#   --amount <amount>  Amount to deposit
```

Deposit a `amount` amount of tokens from erc20 to eUSDC contract.


#### claim
```sh
npx tsx src/pusdc-cli.ts claim --to <address> --amount <amount>
# Options:
# -t, --to <address>     Recipient address
# -a, --amount <amount>  Amount to claim
```

Claim a `amount` amount of tokens to `to`.


#### transfer

```sh
npx tsx src/pusdc-cli.ts transfer --to <address> --amount <value>
# Options:
# --to <address>    Recipient address
# --amount <value>  Token amount (human-readable)
```

Moves a value `amount` of tokens from the caller's account to `to`.

> Note for `--amount <value>`: `--amount 1.5` means `1.5 * 10 ^ decimals`.


#### approve

```sh
npx tsx src/pusdc-cli.ts approve --spender <address> --amount <value>
# Options:
#   --spender <address>  Spender address
#   --amount <value>     Token amount (human-readable)
```

Sets a value `amount` of tokens as the allowance of `spender` over the caller's tokens.


#### transferFrom

```sh
npx tsx src/pusdc-cli.ts transferFrom --from <address> --to <address> --amount <value>
# Options:
#   --from <address>  Sender address
#   --to <address>    Recipient address
#   --amount <value>  Token amount (human-readable)
```

Moves a value `amount` of tokens from `from` to `to` using the allowance mechanism. `value` is then deducted from the caller's allowance.


### Whitelist


#### transferOwnership

```sh
npx tsx src/pusdc-cli.ts transferOwnership --to <address>
# Options:
#   --to <address>  The account of new owner
```

Transfers the contract ownership to `to`.


#### addToWhitelist

```sh
npx tsx src/pusdc-cli.ts addToWhitelist --account <address>
# Options:
#   --account <address>  The account to add to whitelist
```

Adds an `account` to the whitelist.


#### removeFromWhitelist

```sh
npx tsx src/pusdc-cli.ts removeFromWhitelist --account <address>
# Options:
#   --account <address>  The account to remove from whitelist
```

Removes an `account` from the whitelist.


#### isWhitelisted

```sh
npx tsx src/pusdc-cli.ts isWhitelisted --account <address>
# Options:
#   --account <address>  The account address
```

Determines whether the `account` is on the whitelist.


#### getFullWhitelist

```sh
npx tsx src/pusdc-cli.ts getFullWhitelist
```

Retrieves the whitelist.


#### getTotalHandles

```sh
npx tsx src/pusdc-cli.ts getTotalHandles
```

Retrieves all handles for contract status variables, including historical values.




### Decryption

#### allowForDecryption

```sh
npx tsx src/pusdc-cli.ts allowForDecryption --handle <value> [--account <address>]
# Options:
#   --handle <value>     Ciphertext handle(bytes32)
#   --account <address>  The account to grant decryption permission to
```

Grants decryption permission for the `handle` to the specified `account`. If no `account` is provided, the `handle` will be decryptable by anyone.

#### encrypt

```sh
npx tsx src/pusdc-cli.ts encrypt --input <value>
npx tsx src/pusdc-cli.ts encrypt --amount <value>
# Options:
#   --input <value>  Plaintext integer in token base units
#   --amount <value> Token amount in human-readable units
```

Generates a real encrypted payload handle through the FHE SDK. Use `--input` for raw base-unit integers or `--amount` for token-denominated values.


#### userDecrypt

```sh
npx tsx src/pusdc-cli.ts userDecrypt --handle <value>
# Options:
# --handle <value>  Ciphertext handle(bytes32)
```

Retrieves the plaintext corresponding to the `handle`.



