# upbookmarks

浏览器书签 / 设置的加密备份工具，把加密后的快照推送到 Gitee 私有仓库。

## 定位

自用工具。单机备份 + 换机迁移，**不是实时双向同步**。

| 数据 | 谁负责 |
|---|---|
| 书签 | 本扩展 |
| 浏览器设置（Firefox only，白名单子集） | 本扩展 |
| 密码 | **不是本扩展**。KeePassXC 的 `.kdbx` 直接放进同一个 Gitee 私有仓库 |

## 为什么这么做

1. Firefox 中国版账户同步已于 2025-09-29 终止，国际版 Sync 在国内不可靠。
2. 浏览器内核级同步（Chrome Sync / Firefox Sync）的加密能力扩展拿不到，尤其是密码：**Firefox 没有给扩展任何读取密码库的 API**。
3. 用 Gitee 私有仓库做存储，是为了拿到「版本快照 + 数据完全自控」，而这两点现有同步方案都不提供。

## 当前状态

**代码已全部写完；纯逻辑 149 项断言全绿。剩下真实浏览器验收（E1–E5、E9、E10）需要人工加载扩展。**

| 模块 | 验证 |
|---|---|
| `src/lib/constants.js` | 参数的唯一来源 |
| `src/lib/crypto.js` | `tests/crypto-parity.test.mjs` — 23 项，与冻结参考值逐字节一致 |
| `src/lib/gitee.js` | `tests/gitee-client.test.mjs` — 19 项，假 Gitee |
| `src/lib/snapshot.js` | `tests/snapshot.test.mjs` — 22 项，覆盖保留策略与索引重建 |
| `src/lib/collect.js` | `tests/collect.test.mjs` — 24 项，假浏览器 API |
| `src/lib/restore.js` | `tests/restore.test.mjs` — 21 项，两种还原策略 |
| `src/lib/app.js` | `tests/app-flow.test.mjs` — 26 项，端到端编排（真加密） |
| `manifest/` + `src/ui/` | `tests/validate-extension.mjs` — 14 项静态校验 |

```
node tests/run-all.mjs      # 7 个测试文件，149 项断言，无需网络与令牌
```

加载方式与验收步骤见 [05-roadmap.md](05-roadmap.md) 的「真实浏览器验收步骤」。

## 加载到浏览器

**两个浏览器都要求清单必须叫 `manifest.json` 且位于扩展根目录**，所以不能直接加载源码目录，
需要先构建：

```
node tools/build.mjs      # 产出 build/firefox/ 与 build/chrome/
```

| 目标 | 加载路径 |
|---|---|
| Firefox | `about:debugging#/runtime/this-firefox` → 临时载入附加组件 → 选 `build/firefox/manifest.json` |
| Chrome / Edge | `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `build/chrome` |

产物由「共享的 `src/` + 对应浏览器的清单改名」组成，源码仍是单一来源。
两个清单的差异只有三处：`background`（Firefox 需要 `scripts`，Chromium 只认 `service_worker`）、
权限（Chromium 没有 `browserSettings` / `privacy`）、以及 `browser_specific_settings`。

## 文档

| 文件 | 内容 |
|---|---|
| [01-threat-model.md](01-threat-model.md) | 防谁、不防谁、明确的非目标 |
| [02-design.md](02-design.md) | 密钥分层、上传流程、下载流程、恢复流程 |
| [03-parameters.md](03-parameters.md) | 参数约定（所有可调值和固定值） |
| [04-repo-layout.md](04-repo-layout.md) | Gitee 仓库与本地目录结构、数据格式 |
| [05-roadmap.md](05-roadmap.md) | 阶段划分与验证清单 |

## 工程目录

工作区根 `D:\mt-tool` 下并存着许多互不相关的项目与工具目录，**本项目独占 `upbookmarks\` 子目录**，不在根目录散落文件。

```
D:\mt-tool\                     ← 会话工作区根（含大量其他项目）
└── upbookmarks\                ← 本项目，全部内容在这里
    ├── README.md
    ├── 01-threat-model.md
    ├── 02-design.md
    ├── 03-parameters.md
    ├── 04-repo-layout.md
    ├── 05-roadmap.md
    ├── src\        （阶段三创建）
    ├── manifest\   （阶段三创建）
    └── tools\      （阶段二创建）
```

## 约定的强硬立场

- 服务器永远只看到密文。**没有任何"验证身份即可恢复密钥"的通道。**
- 恢复材料（恢复码）**永远不与密文放在同一个仓库**。
- 忘记主口令且丢失恢复码 = 数据不可恢复。这是设计的一部分，不是缺陷。
