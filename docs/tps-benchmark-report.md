# FHE ERC20 TPS 压测报告

生成时间：2026-05-06

## 当前状态

本报告需要使用真实 SDK 加密路径重新生成。旧版 1000 tx 结果依赖 `TPS_ENCRYPTION_SOURCE=trivial` / 固定 handle 调试路径，不能代表 `@primuslabs/fhe-sdk` 真实生成 handle 后的压测结果。

## 重跑要求

正式报告必须满足：

- `TPS_ENCRYPTION_SOURCE=sdk`
- 不设置 `TPS_TRIVIAL_HANDLE`
- `MOCK_TEST` 未开启
- 使用真实已充值、已 whitelist 的 sender 钱包
- 保存完整命令、commit hash、开始时间、结束时间和原始终端输出摘要

推荐命令：

```bash
TPS_TX_COUNT=1000 \
TPS_SEND_CONCURRENCY=50 \
TPS_WAVE_SIZE=50 \
TPS_WAVE_DELAY=200 \
TPS_CONFIRM_TIMEOUT=900 \
npm run tps:testnet:event
```

## 待填写结果

重跑后再填写：

- 发起交易：
- 失败交易：
- 链上确认：
- 完成观测：
- Send Rate：
- On-chain TPS：
- Effective TPS：
- 平均链上确认耗时：
- 平均端到端耗时：

## 注意事项

- `Transfer` event 只能作为事件观测口径；如果要严格衡量 FHE settlement，应使用真实 settlement event 或 balance 解密模式。
- `docs/whitelist-users.csv` 包含 sender 私钥，不应在终端、日志或公开报告中展开。
