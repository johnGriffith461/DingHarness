# 支持渠道

## 先自己看一眼

```bash
ding doctor            # 每项失败都写下一步
ding doctor --fix      # 只修两类安全的：建目录 / 重建检索索引
ding sessions --search <词>
```

桌面端：设置 → 关于 → 导出诊断包（**本地文件**，不上报）。贴 issue 前先看一眼里面有没有密钥
（正常不会有；有就是 bug，请按 `SECURITY.md` 报）。

## 去哪里问

| 类型 | 渠道 |
|---|---|
| Bug / 功能请求 | GitHub Issues（仓库 Issues 页） |
| 用法问题 / 想法 | GitHub Discussions（开了就用；没开就先开 issue） |
| 安全漏洞 | **不要开公开 issue** —— 见 [`SECURITY.md`](SECURITY.md) |
| 插件问题 | 先找插件作者；如果怀疑签名/权限门槛被绕过，报给我们 |

## 提问时带上

- 版本与平台（`ding --version`、`ding doctor` 的第一行）；
- 你做了什么、期望什么、实际什么（三段话就够）；
- 能复现的最小输入（**脱敏**：别贴密钥、别贴私人会话原文）。

## 响应预期

个人维护，尽力而为：一般 issue 几天内会有人看；安全问题按 `SECURITY.md` 的时限。
没有付费支持，也没有 SLA。
