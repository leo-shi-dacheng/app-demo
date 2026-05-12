# FHE ERC20 TPS 压测说明

本文档说明如何使用 `test/tps-benchmark.ts` 对 FHE ERC20 transfer 做 TPS 压测，并解释脚本输出指标的含义。

## 压测目标

本压测区分三类吞吐：

- `Encrypt TPS`：只衡量 `requestEncrypt` 生成加密 payload 的吞吐。
- `On-chain TPS`：衡量已广播 transfer 在链上确认的吞吐，不包含后续 FHE settlement。
- `Effective TPS`：衡量从客户端发起到完成观测信号出现的端到端吞吐。

如果目标是评估 transfer TPS，推荐使用“预加密 + 多钱包独立 pair”模式：

```text
wallet A -> wallet B
wallet C -> wallet D
wallet E -> wallet F
```

不要使用依赖链：

```text
wallet A -> wallet B
wallet B -> wallet D
```

依赖链会让后一笔交易依赖前一笔余额更新，尤其 FHE ERC20 还涉及 settlement，测到的是依赖链路延迟，不是系统 transfer 吞吐。

## 文件结构

```text
test/tps-benchmark.ts        # CLI 入口
test/tps/config.ts           # 环境变量解析
test/tps/colors.ts           # 终端输出颜色
test/tps/wallet-plan.ts      # sender/recipient pair 规划
test/tps/runtime.ts          # ethers + FHE SDK 运行时封装
test/tps/trackers.ts         # balance/event 完成检测
test/tps/metrics.ts          # TPS 和 settlement 统计
test/tps/types.ts            # 类型定义
```

## 前置条件

1. 每个 sender 钱包都需要有足够 HSK 支付 Gas。
2. 每个 sender 钱包都需要有足够 PUSDC 可转账余额。
3. 所有 sender/recipient 私钥和地址统一维护在 `docs/whitelist-users.csv`。脚本默认按相邻两行组成独立 pair：`row1 -> row2`、`row3 -> row4`、`row5 -> row6`。
4. `ACL_ADDRESS`、`WHITELIST_ADDRESS`、`PUSDC_TOKEN_ADDRESS`、`RPC_URL` 必须指向同一网络。
5. balance 模式会解密 recipient balance，脚本会尝试将 controller 钱包加入白名单。
6. 测试网配置可以从 `.env.hashkey.testnet` 读取；直接运行脚本时默认读取 `.env`，使用 npm script 时会通过 `DOTENV_CONFIG_PATH=.env.hashkey.testnet` 指定测试网文件。

## 推荐参数

基础环境变量：

```bash
RPC_URL=https://testnet.hsk.xyz
PUSDC_TOKEN_ADDRESS=0x...
ACL_ADDRESS=0x...
WHITELIST_ADDRESS=0x...
TPS_AMOUNT=1
TPS_TX_COUNT=100
TPS_TX_DELAY=0
TPS_WAVE_SIZE=25
TPS_SEND_CONCURRENCY=25
TPS_WAVE_DELAY=200
TPS_ENCRYPT_MODE=pre
TPS_TRANSFER_VALUE=1
TPS_MODE=balance
```

sender 私钥不要写入 `.env.hashkey.testnet`。默认情况下，脚本会读取 `docs/whitelist-users.csv`，并自动生成：

- `TPS_PRIVATE_KEYS`：来自 CSV 奇数行的 `private_key` 列，作为 sender。
- `TPS_RECIPIENTS`：来自 CSV 偶数行的 `address` 列，作为 recipient，例如 `row1 -> row2`、`row3 -> row4`、`row5 -> row6`。
- 解密钱包池：来自 CSV 所有行的 `private_key` 列，用于 balance 模式按 recipient 自己的钱包解密余额。

如需使用其它 CSV 文件，可设置 `TPS_WALLET_CSV=path/to/file.csv`。

HashKey testnet 已有网络和合约地址模板：

```bash
RPC_URL=https://testnet.hsk.xyz
ACL_ADDRESS=0xbe7673C903C2255510066f788b65abDEf4674f07
FHE_EXECUTOR_ADDRESS=0x31834c9F9bc152C5Fad29ea13f2a9fdCD6b3b315
WHITELIST_ADDRESS=0x7d4B3c10144cC67341a50769BE72cc3b9F269894
PUSDC_TOKEN_ADDRESS=0xE1B8a1837089b384F6cf1Bb3440b5E56b1b30493
```

不要使用随机 recipient。当前 eUSDC transfer 要求收款地址也在 whitelist 中；如果不显式设置 `TPS_RECIPIENTS`，脚本只会从 `docs/whitelist-users.csv` 派生 whitelisted recipient。

## 执行方式

推荐先用小交易数做冒烟。脚本会自动从 `docs/whitelist-users.csv` 读取 sender 和 recipient：

```bash
TPS_MODE=balance TPS_TX_COUNT=1 TPS_TX_DELAY=200 npx tsx test/tps-benchmark.ts
```

使用 `.env.hashkey.testnet` 做测试网冒烟：

```bash
npm run tps:testnet:smoke
```

正式测 transfer TPS：

```bash
TPS_ENCRYPT_MODE=pre TPS_TX_COUNT=100 TPS_TX_DELAY=0 npx tsx test/tps-benchmark.ts
```

使用 `.env.hashkey.testnet` 做测试网 transfer TPS：

```bash
TPS_TX_COUNT=100 npm run tps:testnet
```

完整 1000 tx transfer TPS 测试：

```bash
TPS_TX_COUNT=1000 \
TPS_SEND_CONCURRENCY=25 \
TPS_WAVE_SIZE=25 \
TPS_WAVE_DELAY=200 \
TPS_CONFIRM_TIMEOUT=900 \
npm run tps:testnet:event
```

该命令会使用 `docs/whitelist-users.csv` 中的白名单钱包按独立 pair 发送交易。当前 50 个 CSV 钱包会派生出 25 个 sender lane；每个 wave 默认最多包含 25 笔交易，每个 sender lane 同时发送一笔；下一轮 wave 会等上一轮交易都被 RPC 接收后再开始，因此同一钱包的 nonce 始终按顺序递增。

测完整用户链路：

```bash
TPS_ENCRYPT_MODE=inline TPS_DURATION=60 TPS_TX_DELAY=200 npx tsx test/tps-benchmark.ts
```

## 关键参数

- `TPS_WALLET_CSV`：钱包 CSV 路径，默认 `docs/whitelist-users.csv`。CSV 必须包含 `address` 和 `private_key` 列。
- `TPS_PRIVATE_KEYS`：逗号分隔的 sender 私钥列表。默认从 CSV 奇数行读取；正式 TPS 压测至少需要 25 个 sender，少于 25 个时脚本会直接报错。多 sender 可以减少单账号 nonce 串行对结果的影响。
- `TPS_RECIPIENTS`：逗号分隔的 recipient 地址。默认从 CSV 偶数行派生。数量可以是 1 个或与 sender 数量相同。
- `TPS_RECIPIENT`：单个 recipient 地址；仅在 `TPS_RECIPIENTS` 为空时生效。注意当前 eUSDC transfer 要求 recipient 也在 whitelist 中。
- `WHITELIST_ADDRESS`：独立白名单合约地址。脚本会用 `verifyWhitelisted(bytes32)` 校验 controller 钱包；hash 规则与 `cast keccak <address>` 一致。
- `TPS_ENCRYPT_MODE=pre`：先完成所有加密，再统一进入 transfer 发送阶段。推荐用于 transfer TPS。
- `TPS_ENCRYPT_MODE=inline`：每笔交易按 `encrypt -> transfer` 执行。推荐用于端到端体验测试。
- `TPS_PRE_ENCRYPT`：兼容开关。`true/1/yes/on` 等同于 `TPS_ENCRYPT_MODE=pre`，`false/0/no/off` 等同于 `TPS_ENCRYPT_MODE=inline`。
- `TPS_ENCRYPTION_SOURCE=sdk`：默认使用 FHE SDK `requestEncrypt` 生成真实 payload/handle；这与 `privacy-computation` 中下载公钥、加密、上传 ciphertext 后拿 handle 的真实链路对应。
- `TPS_ENCRYPTION_SOURCE=trivial`：仅用于调试 attestation payload 路径，payload 形态为 `dataType=0` + ABI 编码 amount。该模式必须设置 `FHE_EXECUTOR_ADDRESS`，并通过 `trivialEncrypt` 现场生成 handle；不要使用固定 handle 做真实压测。
- `TPS_TRANSFER_VALUE`：每笔 transfer 随交易发送的 HSK 数量，单位 HSK。HashKey testnet PUSDC transfer 当前需要 `1`。
- `TPS_TX_COUNT`：总发送交易数。`TPS_TX_DELAY=0` 时必须设置。
- `TPS_DURATION`：发送阶段最长持续时间。
- `TPS_TX_DELAY`：用于按 duration 推导交易数的旧参数。并发 wave 模式下，发送节流优先使用 `TPS_WAVE_DELAY`。
- `TPS_WAVE_SIZE`：每个发送 wave 包含的交易数，默认等于 sender pair 数。为了保证同一钱包 nonce 顺序，不能大于 sender pair 数。
- `TPS_SEND_CONCURRENCY`：每个 wave 内同时提交到 RPC 的交易数，默认等于 `TPS_WAVE_SIZE`。如果 RPC 限流，可降低到 `25` 或更低。
- `TPS_WAVE_DELAY`：两个 wave 之间的等待时间，单位 ms。1000 tx 测试建议从 `200` 开始，再按 RPC 表现调整。
- `TPS_MODE=balance`：通过 recipient balance 增量判断 settlement 完成。该模式要求 controller 钱包能解密所有 recipient balance。
- `TPS_MODE=event`：通过事件判断完成，需要设置 `TPS_SETTLEMENT_EVENT`。只有监听到真正表示 settlement 完成的事件时，才可以把该模式作为完成 TPS 口径。
- `TPS_POLL_INTERVAL`：balance 模式轮询 recipient balance 的间隔，单位 ms，默认 `5000`。调小会减少观测延迟，但会增加解密请求压力。
- `TPS_CONFIRM_TIMEOUT`：等待链上确认的超时时间，单位秒。
- `TPS_SETTLE_TIMEOUT`：最后一笔确认后等待 FHE settlement 的超时时间，单位秒。
- `TPS_DECRYPT_TIMEOUT`：单次 balance 解密总超时时间，单位 ms，默认 `15000000`。gRPC 解密会复用 keepalive 长连接；如果遇到 `404 decryption is not available` 或 `DEADLINE_EXCEEDED`，会在该总超时内轮询重试。

## 指标解读

- `Encrypt TPS`：加密准备阶段的吞吐。`pre` 模式下它不应计入 transfer TPS。
- `Send Rate`：客户端广播交易速率，主要反映本地加密、RPC、nonce 管理和发送循环。
- `On-chain TPS`：`confirmed / (lastConfirmedAt - firstConfirmedAt)`，只统计 receipt 成功的链上 transfer 吞吐。
- `Effective TPS`：`completed / (lastCompletedAt - firstInitiatedAt)`，用于观察用户端到端体验。`TPS_MODE=balance` 下，只有解密确认余额增加后才计入 completed，因此会比理论链上 TPS 更保守。

`Completion observer` 会输出完成观测层的额外信息：

- `Poll interval`：每轮 balance 检查的间隔。真实到账发生在两次轮询之间时，最多会额外多记一个 poll interval。
- `Poll rounds`：完成 tracker 实际轮询次数。
- `Decrypt calls` / `Avg decrypt`：balance 模式为确认完成而发起的解密次数和平均耗时。这些耗时会计入 `Effective TPS` 的观察时间。

做 transfer TPS 对比时，优先记录 `On-chain TPS`，并确保使用 `TPS_ENCRYPT_MODE=pre`。如果需要端到端体验口径，再参考 `Effective TPS`；如果 tracker 没有观察到完成信号，报告仍会输出 `On-chain TPS`，但 `Effective TPS` 会显示为不可用。

## 推荐压测流程

1. 准备至少 50 个 CSV 钱包，并提前给 sender 行钱包转入 HSK 和 PUSDC；50 个 CSV 钱包会形成 25 个独立 sender/recipient pair。
2. 确认 `docs/whitelist-users.csv` 里的 `address` 都已加入 eUSDC whitelist；不要让脚本生成随机 recipient。
3. 在保持独立 sender/recipient pair 不变的前提下，使用 `TPS_TX_COUNT=1` 做连通性冒烟测试。
4. 将 `TPS_TX_COUNT` 提高到 50、100、200 分批测试。
5. 使用 1000 tx full test：`TPS_TX_COUNT=1000 TPS_WAVE_SIZE=25 TPS_SEND_CONCURRENCY=25 TPS_WAVE_DELAY=200 npm run tps:testnet:event`。
6. 如果出现 RPC 限流、pending 堆积或确认超时，先把 `TPS_SEND_CONCURRENCY` 降到 `25`，再增加 `TPS_WAVE_DELAY`。
7. 对比 `pre` 和 `inline` 两种模式，分别记录 transfer TPS 和端到端 TPS。

## 注意事项

- `docs/whitelist-users.csv` 已是 sender/recipient 私钥和 recipient 地址来源，不要再把私钥复制到 `.env.hashkey.testnet`、`.env` 或终端日志。
- 如果使用 `.env.hashkey.testnet` 作为模板，只保留空的 `PRIVATE_KEY` / `TPS_PRIVATE_KEYS` 占位；真实 sender 私钥运行时由脚本从 `docs/whitelist-users.csv` 读取。
- 正式 TPS 压测要求至少 25 个 sender 钱包；小规模冒烟只应降低交易数，不应降低钱包数。
- `TPS_TX_DELAY=0` 会快速打满本地和 RPC 发送能力，测试前先确认 RPC 限流策略。
- 如果 RPC 返回 pending 堆积或确认超时，降低 `TPS_TX_COUNT` 或增加 sender 数量。
- balance 模式依赖 recipient balance 解密权限，controller 无法解密 recipient balance 时会在 baseline 阶段失败。
- event 模式只适合作为对照或调试；若要作为真正完成口径，需要把 `TPS_SETTLEMENT_EVENT` 改成目标合约实际 settlement 完成事件名。
