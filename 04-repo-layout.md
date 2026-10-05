# 04 · 仓库与数据布局

## 一、Gitee 仓库结构

```
<repo>/
├── keyfile.json                       ← 全局唯一，包裹后的 DEK（见 02-design.md）
├── README.md                          ← 说明这是加密备份，勿设为公开
├── backups/
│   ├── desktop/
│   │   ├── index.json                 ← 该机快照索引（明文元数据）
│   │   ├── 20260214T103000Z.enc
│   │   └── 20260212T090000Z.enc
│   ├── laptop/
│   │   ├── index.json
│   │   └── 20260213T201100Z.enc
│   └── office-pc/
│       ├── index.json
│       └── 20260130T180200Z.enc
└── passwords/
    └── vault.kdbx                     ← 由 KeePassXC 生成，本扩展不读写、不解密
```

要点：

- **每台机器一个目录**，互不干扰 → 威胁模型 T6（互相覆盖）在结构上不可能发生。
- `keyfile.json` 位于根，**全局唯一**，不是每机一份。所有机器用同一份包裹数据。
- `.enc` 后缀标明是密文（内容为 base64 编码的 IV‖ciphertext）。
- 仓库必须为**私有**。创建时 `private: true`；若发现仓库为公开，扩展应拒绝上传并报错。
- `passwords/vault.kdbx` 由**用户手动**放入（用 KeePassXC 另存或网页上传），扩展只把它当作一个不认识的二进制文件，**不做任何处理**。

## 二、本地工程目录（阶段三创建，此处仅约定）

```
D:\mt-tool\                     ← 会话工作区根（含大量其他项目，与本项目无关）
└── upbookmarks\                ← 本项目，全部内容在这里
    ├── README.md
    ├── 01-threat-model.md
    ├── 02-design.md
    ├── 03-parameters.md
    ├── 04-repo-layout.md
    ├── 05-roadmap.md
    ├── src\                    ← 共享代码（两个浏览器同一套）
    │   ├── lib\
    │   │   ├── crypto.js       ← KDF / 加解密 / 包裹解包
    │   │   ├── gitee.js        ← Gitee API 封装（带 sha 乐观锁）
    │   │   ├── snapshot.js     ← 快照组装、索引维护、保留策略
    │   │   ├── collect.js      ← 书签与设置采集
    │   │   ├── restore.js      ← 还原与差异预览
    │   │   └── platform.js     ← browser/chrome 命名空间兼容
    │   ├── ui\                 ← 弹窗与选项页
    │   └── background.js
    ├── manifest\
    │   ├── firefox.json
    │   └── chrome.json
    └── tools\                  ← 阶段二验证脚本
```

### 跨浏览器清单差异（已核实）

Firefox 不支持 `background.service_worker`；Chrome 的 MV3 只支持 service worker。**两边同时写上即可各自取用**（[MDN background 清单键](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)）：

```json
"background": {
  "scripts": ["background.js"],
  "service_worker": "background.js"
}
```

其余差异集中在 `manifest/` 两个文件里，`src/` 下的代码保持单一来源。

## 三、快照载荷格式

### 3.1 书签

直接使用 WebExtension `bookmarks.getTree()` 的结构，**只保留必要字段**：

```json
{
  "bookmarks": {
    "children": [
      {
        "title": "书签栏",
        "children": [
          { "title": "示例", "url": "https://example.com/", "dateAdded": 1739000000000 }
        ]
      }
    ]
  }
}
```

- 省略 `id` / `parentId`（跨浏览器、跨 profile 的 id 不稳定，还原时由浏览器重新分配）。
- 保留 `dateAdded`（数值毫秒），便于还原后排序与差异比较。
- **不备份 favicon**（体积大、可重新获取、且会引入额外网络请求）。

### 3.2 设置（v1 白名单）

| 来源 API | 键 |
|---|---|
| `browserSettings` | `homepageOverride`, `newTabPageOverride`, `imageAnimation`, `javascriptEnabled`, `allowPopupsForUserEvents`, `cacheEnabled`, `cookiesEnabled`, `webNotificationsDisabled` |
| `browser.privacy` | `network.*`, `websites.*` 下的可读子项 |

**取不到的键不进快照**，并且在载荷里记录：

```json
{
  "settings": { "homepageOverride": "https://..." },
  "settings_unavailable": ["browserSettings.javascriptEnabled"],
  "settings_platform_note": "chrome:no-browserSettings"
}
```

**绝不写入猜测值或默认值。** 读不到就是读不到，如实记录，避免"还原后设置被静默改成默认值"。

**待验证**：上表键名取自 `browserSettings` 文档，但**每一项的可读/可写性随 Firefox 版本变化**。阶段三实现前需逐项实测，并在 UI 中只展示真正可读的项。

### 3.3 Chrome / Edge 的差异

Chrome 没有 `browserSettings` / `browser.privacy`，该平台：

- `settings` 为空对象；
- `settings_platform_note` 标注原因；
- UI 明确提示"此平台不支持设置备份，仅备份书签"。

## 四、加密文件内容

`.enc` 文件的内容 = `base64(IV ‖ ciphertext‖tag)`，**单行，无换行**。

- IV 前置，长度固定 12 字节，因此正文偏移量可预测。
- 不使用 JSON 包壳存放密文，减少体积与解析分支。
- AES-GCM 的 tag 由 WebCrypto 自动附在 ciphertext 末尾，无需单独处理。

## 五、明文与密文的边界（务必遵守）

| 数据 | 位置 | 是否加密 |
|---|---|---|
| 书签、设置 | `backups/**/*.enc` | ✅ 加密 |
| 快照时间、机器名、文件大小、git sha | `backups/**/index.json` | ❌ 明文（元数据） |
| KDF 算法、迭代次数、salt、IV | `keyfile.json` | ❌ 明文（非秘密，且解密必需） |
| 包裹后的 DEK | `keyfile.json` | ✅ 加密 |
| 恢复码本身 | **不入库** | — |
| 主口令本身 | **不入库** | — |
| 密码库 | `passwords/vault.kdbx` | ✅ 由 KeePassXC 加密，本工具不参与 |

**元数据不加密是有意选择**：这样在忘记主口令时，用户仍能看到"有哪些快照、来自哪台机器、什么时候"，便于判断该用哪个恢复材料。代价是泄漏"何时备份、备份多大、有几台机器"——已列入非目标 N6。
