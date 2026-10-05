# 03 · 参数约定

所有可调值集中在此。**代码中不得出现本文件之外的字面量。**

## 一、加密与密钥

| 参数 | 值 | 说明 |
|---|---|---|
| `CIPHER` | `AES-256-GCM` | 认证加密，自带完整性校验，不需要额外 HMAC |
| `IV_BYTES` | `12` | GCM 标准长度。**每条快照独立随机生成，绝不复用** |
| `DEK_BYTES` | `32` | 256 bit |
| `KEK_BYTES` | `32` | 256 bit |
| `GCM_TAG_BITS` | `128` | 默认值，勿改 |
| `AAD_PREFIX` | `example-repo` | AAD 拼接前缀 |
| `WRAP_IV_BYTES` | `12` | 包裹 DEK 时使用的 IV |

## 二、密钥派生
| 参数 | 值 | 说明 |
|---|---|---|
| `KDF_PASSWORD_ALGO` | `PBKDF2-SHA256` | 纯 WebCrypto 可用，无第三方依赖 |
| `KDF_PASSWORD_ITERATIONS` | `600000` | 下限。设备性能允许时可上调 |
| `KDF_PASSWORD_SALT_BYTES` | `16` | 随机，存 `keyfile.json` |
| `KDF_RECOVERY_ALGO` | `HKDF-SHA256` | 恢复码熵高（160 bit），无需慢 KDF |
| `KDF_RECOVERY_INFO` | `upbookmarks/recovery-key/v1` | HKDF 的 info 参数，做域分离 |
| `KDF_RECOVERY_SALT_BYTES` | `16` | 随机，存 `keyfile.json` |
| `RECOVERY_CODE_BITS` | `160` | 见下方编码约定 |

### 为什么两条路径用不同 KDF

- **主口令熵低**（可能只有 40~60 bit），必须靠**慢**来拉高攻击成本 → PBKDF2 600000 次。
- **恢复码熵高**（160 bit），爆破本就不可行，用慢 KDF 只会让用户等待 → HKDF 即时完成。
- 两者都输出 32 字节 KEK，接口一致，只是成本不同。

### 主口令强度要求（量化）

在 600000 次迭代下，按离线攻击者 10^4 次猜测/秒（GPU）估算：

| 主口令 | 熵 | 离线爆破 |
|---|---|---|
| `123456` | ~20 bit | 秒级 |
| 一个常见单词 | ~13 bit | 秒级 |
| 5 个随机词 | ~65 bit | 数万年 |
| **6 个随机词（要求）** | **~77 bit** | **不可行** |

**因此 UI 必须强制/引导使用口令短语（≥6 词）。** 短密码在离线爆破下没有任何安全边际——[01-threat-model.md](01-threat-model.md) 的 T3 已经确认攻击者必然能拿到文件。

**强度门槛的具体取值**（`PASSWORD_STRENGTH`，UI 的说明文字从这里自动生成）：

| 条件 | 值 | 说明 |
|---|---|---|
| 最少段数 | `6` | **是「至少」不是「必须」** —— 可以更多段 |
| 最少总长度 | `16` 字符 | 6 段中文短语通常 16–17 字符（每段 2–3 个汉字），门槛必须 ≤16 才不会让"≥6 段"自相矛盾 |
| 每段长度 | **不限** | 限制段内长度没有意义，且会误伤"每段 2 个汉字"这种合理写法 |
| 分隔符 | 空格、短横、下划线、英文标点、**中文标点**（`、，。；：·／`） | 早期只认空格与短横，把中文用户的口令判成"1 段"并拒绝——**实现缺陷，不是用户的问题** |

**三条经验教训（都曾真实踩到）**：

1. **门槛必须自洽**：曾把总长度定为 18 而段数定为 6，结果 6 段中文几乎永远过不了 —— 等于变相强制 7 段却又不告知。
2. **条件必须写在界面上**：曾只在失败时弹一句报错，用户看不到规则，只能反复试错。
3. **规则要和输入方式匹配**：口令框曾默认遮蔽，而 6–8 段、两次一致的口令在遮蔽下几乎必然输错。现在**默认可见**并提供「隐藏」按钮。

#### ⚠️ 中文口令短语的熵显著低于英文

上表的 `12.9 bit/词` 取自英文常用词表（约 7776 词，`log2(7776) ≈ 12.9`）。**中文短语达不到这个数值**：

- 中文"词"的候选空间远大于英文词表，但**用户实际会用的中文短语高度集中**（日常词汇、成语、歌词），真实熵通常只有英文随机词的几分之一；
- 因此 **中文短语需要比 6 段更多的段数**，才能达到同等强度。

**实现约束**：`assessPasswordStrength()` 只做启发式检查（段数与总长度），**它拦得住 `123456`，但拦不住"看起来像短语其实很好猜"的中文口令**。UI 必须同时给出明确建议：使用**自己拼出来的、不构成常用表达**的多段短语，或改用随机生成的英文词表短语。

**不要**把这个启发式当作安全保证——它只是最低门槛。

### 恢复码编码

- 160 bit 随机 → Base32 编码（去除易混字符 `0/O/1/I/L`）。
- 展示为分组字符串，便于抄写，例如 `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`。
- 生成后**只显示一次**，要求用户当场抄写/打印并二次确认。

### 跨运行时一致性（已实测确认）

同一组固定输入在三个运行时上逐字节比较，**全部相同**（11/11）：

| 运行时 | 结果 |
|---|---|
| Node v24.11.1（阶段二脚本环境） | 参考值 |
| Chrome 152 Headless | ✅ 一致 |
| Firefox 159 | ✅ 一致 |

比较项：主口令 KEK、恢复码 KEK、DEK、包裹后的 DEK、AES-GCM 密文、明文哈希、AAD 不匹配是否被拒。

**实现约束**：本文件的参数在浏览器 WebCrypto 下产出与 Node 完全相同的结果，因此**阶段二的验证结论可直接外推到扩展，无需重做**。`crypto.subtle`（含 `wrapKey`/`unwrapKey`/HKDF）在 Firefox 与 Chrome 的扩展上下文中均可用。

## 三、上传与保留
| 参数 | 值 | 说明 |
|---|---|---|
| `RETENTION_PER_MACHINE` | `20` | 每台机器保留的快照份数 |
| `SNAPSHOT_TIME_FORMAT` | `YYYYMMDDTHHMMSSZ` | UTC，秒级精度 |
| `MAX_SNAPSHOT_BYTES` | `6 MiB` | **载荷（密文）** 上限。上传前另需校验 base64 膨胀后的请求体不超 `MAX_REQUEST_BYTES` |
| `MAX_REQUEST_BYTES` | `8 MiB` | `content` 字段（base64）的请求体上限，已实测可成功上传 |
| `UPLOAD_RETRY` | `3` | 网络失败重试次数 |
| `UPLOAD_RETRY_BACKOFF_MS` | `1000, 4000, 10000` | 退避序列 |
| `AUTO_UPLOAD` | `false` | v1 仅手动触发，不做定时/事件自动上传 |

## 四、网络

| 参数 | 值 |
|---|---|
| `GITEE_API_BASE` | `https://gitee.com/api/v5` |
| `AUTH_HEADER` | `Authorization: Bearer <PAT>` |
| `PAT_SCOPES` | 仅 `projects`。不申请 `user_info`，不申请组织权限 |
| `REQUEST_TIMEOUT_MS` | `30000` |

### Gitee 接口清单（已核实）

| 用途 | 方法 | 路径 |
|---|---|---|
| 列目录（返回数组，含 `name`/`path`/`sha`/`size`/`type`） | `GET` | `/repos/{owner}/{repo}/contents/{path}` |
| 读文件（返回 `sha` + base64 `content`） | `GET` | 同上（路径为文件） |
| 新建文件 | `POST` | 同上 |
| 更新文件（**必须带 `sha`**） | `PUT` | 同上 |
| 删除文件（带 `sha` + `message`） | `DELETE` | 同上 |

依据：Gitee OpenAPI v5 与 [Gitea API 同构文档](https://docs.gitea.com/enterprise/api/operations/repo-get-contents/)（"Update a file if SHA is set, or create the file if SHA is not set"）。

### Gitee 返回体实测结果（V9 只读探测，已确认）

探测脚本：`tools/v9-probe-gitee.mjs`，原始报告：`tools/out/v9-report.json`。

| 请求 | HTTP | 返回体 |
|---|---|---|
| `GET contents/`（目录） | `200` | **JSON 数组**。条目字段：`type`(`dir`/`file`) `size` `name` `path` `sha` `url` `html_url` `download_url` `_links`；目录条目 `size` 为 `null` |
| `GET contents/<subdir>` | `200` | 同上，数组 |
| `GET contents/<file>` | `200` | **单对象**。字段在目录条目基础上多出 `encoding`(`base64`) 与 `content` |
| `GET contents/<不存在的路径>` | **`200`** | **`[]`（空数组）** |
| `GET /repos/<不存在的仓库>` | `404` | `{"message":"Not Found Project"}` |
| `GET contents/?ref=<branch>` | `200` | 支持指定分支 |

**两条必须写进实现的结论：**

1. **「路径不存在」不能用 HTTP 状态码判断。** 它返回 `200` + 空数组，而**不存在的仓库**才是 `404`。因此判断逻辑是：解析 body → 若是数组且长度为 0 → 视为不存在（可创建）。这与"目录为空"在返回体上**无法区分**，好在对本工具而言两者行为一致（都当作"没有这个文件，去创建"）。
2. **`sha` 是 40 位十六进制（SHA-1），且与目录条目上的 `sha` 完全一致。** 所以列目录一次即可拿到全部 `sha`，更新文件时不必额外发一次读请求。`sha` 的值就等于 git 的 blob 哈希。

### 写入类接口实测结果（V9 写入探测，已确认）

在真实私有仓库 `example-owner/example-repo` 上完成完整生命周期（建 → 重复建 → 读 → 冲突 → 改 → 删）。

| 操作 | 请求 | HTTP | 返回体 / 错误信息 |
|---|---|---|---|
| 仓库元数据 | `GET /repos/{owner}/{repo}` | `200` | `private: true`；`permission: {pull,push,admin}`；**空仓库的 `default_branch` 为 `null`** |
| **创建** | `POST contents/<path>`（不带 `sha`） | **`201`** | **只返回 `content` 与 `commit` 两个对象**；blob sha 在 `content.sha` |
| **重复创建** | `POST` 同名（不带 `sha`） | **`400`** | `{"message":"文件名已存在"}` |
| **读取** | `GET contents/<path>` | `200` | 单对象，`encoding: "base64"`，`sha` 与创建时一致 |
| **更新（sha 过期）** | `PUT` + 错误 `sha` | **`400`** | `{"message":"Blob SHA does not match"}` |
| **更新（sha 正确）** | `PUT` + 正确 `sha` | **`200`** | sha 变为新值（已确认会变化） |
| **删除** | `DELETE` + `sha` + `message` | **`200`** | 成功 |
| 删除后再读 | `GET contents/<path>` | **`200`** | `[]` —— 与只读探测的形态**完全一致** |

**由此得到三条必须写进实现的结论：**

1. **乐观锁真实有效。** 用过期 `sha` 更新会被拒绝（`Blob SHA does not match`），所以"防止覆盖别台机器的改动"是有服务端保障的，不是我们自己的约定。
2. **两次"不存在"的返回形态一致**（公开仓库的不存在路径、私有仓库删除后的路径，都是 `200` + `[]`）。因此实现里只有**一条**"文件不存在"的判断路径，不需要为私有仓库写特例。
3. **`POST` 的返回体只含 `content` 与 `commit`**，不是完整文件对象。更新时要用的 `sha` 必须从 `content.sha` 取，或者干脆重新 `GET` 一次。

**因此实现应采用的判断顺序：**

```
1) GET contents/<path>
     ├─ 单对象 → 存在 → 记住 sha
     └─ [] → 不存在 → 用 POST 创建
2) POST 若返回 400「文件名已存在」→ 说明并发下被抢先创建
     → 重新 GET 取 sha → 改用 PUT 更新
```

### 大文件与空仓库的行为（爬阶梯实测，已确认）

在临时私有仓库上从 0.5 MiB 爬到 8 MiB（base64 后）逐档验证，仓库用完即删。

**大文件：Gitee 没有"大文件不内联"的门槛。**

| 明文字节 | POST | GET | `encoding` | `content` |
|---|---|---|---|---|
| 0.38 MiB | `201` (827ms) | `200` | `base64` | ✅ 完整 |
| 0.75 MiB | `201` (865ms) | `200` | `base64` | ✅ |
| 1.50 MiB | `201` (1104ms) | `200` | `base64` | ✅ |
| 3.00 MiB | `201` (1296ms) | `200` | `base64` | ✅ |
| **6.00 MiB** | `201` (1772ms) | `200` | `base64` | ✅ 完整 |

- 这一点**与 GitHub 不同**（GitHub 对 1 MB 以上返回空 `content`）。Gitee 直到实测的最大档位仍内联返回 base64。
- `download_url` 取原始数据也验证可用（`Authorization: Bearer <PAT>`），作为兜底路径。
- 因此读取**只需要一条路径**：`GET contents` → base64 解码。

**空仓库（零提交）首次上传：**

| 检查 | 结果 |
|---|---|
| 新建私有空仓库的 `default_branch` | **`null`** |
| 首次 `POST` **省略 `branch` 参数** | ✅ `201` 成功 |
| 首次 `POST` 传 `branch: "master"` | ✅ `201` 成功，且与省略时落在**同一分支** |
| 首次提交后再读仓库元数据 | `default_branch` 变为 `"master"` |

**结论：空仓库场景直接省略 `branch` 参数**，不要依赖 `default_branch`（它是 `null`）。已验证这与显式传 `master` 等价。

### 尺寸上限的真实约束（重要修正）

`MAX_SNAPSHOT_BYTES` 必须区分两个尺寸，否则会在接近上限时才失败：

| 尺寸 | 含义 |
|---|---|
| **载荷尺寸**（加密后的密文） | 我们真正关心的数据量 |
| **请求体尺寸**（`content` 字段里的 base64） | = 载荷 × **4/3**，这才是 Gitee 实际接收的 |

因此：

- `MAX_SNAPSHOT_BYTES` 应定义为**载荷（密文）字节数**，并在上传前按 `payload × 4/3 ≤ MAX_REQUEST_BYTES` 校验；
- 新增 `MAX_REQUEST_BYTES = 8 MiB`（base64 后的请求体上限，实测 8 MiB 请求体可成功上传，1772ms）；
- 换算后**载荷上限约 6 MiB**。本工具的真实快照（书签 + 设置）通常在几十 KB 到几 MB，距离上限很远，所以该限制只是安全阀，不构成实际约束。

## 五、仓库与路径约定

| 参数 | 值 |
|---|---|
| `REPO_ROOT` | 仓库根 |
| `KEYFILE_PATH` | `keyfile.json` |
| `BACKUPS_DIR` | `backups` |
| `MACHINE_DIR` | `backups/<machine_name>` |
| `MACHINE_INDEX` | `backups/<machine_name>/index.json` |
| `SNAPSHOT_PATH` | `backups/<machine_name>/<snapshot_id>.enc` |

### index.json 结构

```json
{
  "format": "upbookmarks/index",
  "format_version": 1,
  "machine": "desktop",
  "snapshots": [
    {
      "id": "20260214T103000Z",
      "file": "20260214T103000Z.enc",
      "created_at": "2026-02-14T10:30:00Z",
      "bytes": 41234,
      "sha": "<git blob sha>"
    }
  ]
}
```

**索引只含元数据，不含书签内容，因此明文存储。** 它是**纯派生数据**：删掉可以从目录列表重建。所有写入冲突都以"以文件系统为准重建"解决。

## 六、本地存储（`storage.local`）

| 键 | 内容 | 是否敏感 |
|---|---|---|
| `gitee_owner` | 仓库所有者 | 否 |
| `gitee_repo` | 仓库名 | 否 |
| `pat` | 个人访问令牌 | **是**（见下方限制） |
| `machine_name` | 本机别名 | 否 |
| `machine_id` | 本机唯一标识（用于识别重名机器） | 否 |
| `remember_days` | 「信任此设备」有效期（天），0 = 关闭 | 否 |
| `device_key` | 不可导出的设备密钥（加密记住的口令） | 否（不可导出） |
| `auto_backup` / `auto_backup_minutes` | 自动备份开关与间隔 | 否 |
| `last_snapshot_id` | 本机最近上传的快照 id | 否 |
| `current_source` | 本机当前状态的来源机器 | 否 |
| `pre_restore_backup` | 还原前的本地书签备份 | **是**（含书签内容） |

### ⚠️ 环境差异：`get(null)` 在本机 Firefox Nightly 159 上返回空对象

**实测（2026-10-05）**：

| 调用 | 结果 |
|---|---|
| `storage.local.set(obj)` | ✅ 正常写入 |
| `storage.local.get('某个键')` | ✅ 正常读回 |
| `storage.local.get(['键1','键2'])` | ✅ 正常读回 |
| **`storage.local.get(null)`（读取全部）** | ❌ **返回空对象 `{}`** |
| `get(undefined)` / `get()` / `get([])` / `get({})` | ❌ 同样返回空对象 |

验证方式：写入一个键后立刻 `get('该键')` 能读到，而同一次 `get(null)` 报告 **0 个键**。

**实现约束（必须遵守）**：

1. **不要依赖 `get(null)` 读配置** —— 用 `readAllConfig()`（按 `ALL_STORE_KEYS` 显式列出键名读取）。
2. `storageAdapter.getAll()` 提供稳健实现：先试 `get(null)`，再按已知键补齐，**取并集**，对两种行为都正确。
3. 诊断代码若用 `get(null)` 判断"存储是否为空"，会得出**错误结论** —— 本项目就曾因此误判为"写入失败"，实际是**读取失败**（数据一直在）。

### ⚠️ 临时加载的扩展在 Firefox 重启后消失

`about:debugging` 的「临时载入附加组件」**只在当前浏览器会话有效**，重启后扩展被移除。而且每次临时加载都是一个**新的扩展身份**（新 UUID）与一份**空存储**。

这会造成两个假象：**"扩展不见了"**，以及**"配置又丢了"**（其实是新实例的空存储，不是旧实例的数据被删）。

**长期使用必须打包成 `.xpi` 正式安装**：`node tools/package.mjs`，前提是 Nightly / Developer Edition 里把 `xpinstall.signatures.required` 设为 `false`（Release 版不允许关闭该项）。

### 关于 PAT 的诚实说明

`storage.local` 在磁盘上是 **profile 目录里的明文文件**，本机任意进程可读。因此：

- PAT 存此处**只是够用，不是安全**；
- 缓解：PAT 只给 `projects` 权限；建议在 Gitee 侧限制其可访问的仓库范围；
- **DEK 绝不写入 `storage.local`**，只在会话内存中缓存，浏览器关闭即失效。
