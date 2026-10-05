/**
 * 参数常量 —— 唯一来源是 docs/03-parameters.md
 *
 * 这个文件是唯一允许出现魔法数字的地方。其他模块一律从这里 import。
 * 修改任何值之前，先改 03-parameters.md，再同步这里。
 *
 * 本文件不依赖任何浏览器或 Node 专有 API，因此可在两边共用。
 */

/** 加密与密钥 */
export const CIPHER = 'AES-GCM';
export const IV_BYTES = 12;              // GCM 标准长度；每条快照独立随机，绝不复用
export const DEK_BYTES = 32;
export const KEK_BYTES = 32;
export const GCM_TAG_BITS = 128;
export const AAD_PREFIX = 'upbookmarks';
export const WRAP_IV_BYTES = 12;

/** 密钥派生 */
export const KDF_PASSWORD_ALGO = 'PBKDF2-SHA256';
export const KDF_PASSWORD_ITERATIONS = 600000;
export const KDF_PASSWORD_SALT_BYTES = 16;
export const KDF_RECOVERY_ALGO = 'HKDF-SHA256';
export const KDF_RECOVERY_INFO = 'upbookmarks/recovery-key/v1';
export const KDF_RECOVERY_SALT_BYTES = 16;
export const RECOVERY_CODE_BITS = 160;

/** 文件格式标识 */
export const KEYFILE_FORMAT = 'upbookmarks/keyfile';
export const SNAPSHOT_FORMAT = 'upbookmarks/snapshot';
export const INDEX_FORMAT = 'upbookmarks/index';
export const FORMAT_VERSION = 1;

/**
 * 应用版本 —— **版本号的唯一来源**。
 *
 * 发布前改这里，并同步 `manifest/*.json` 的 `version`；
 * `tools/release.mjs` 会校验两者一致，不一致直接报错。
 */
export const APP_VERSION = '0.0.1';

/** 上传与保留 */
export const RETENTION_PER_MACHINE = 20;
export const MAX_SNAPSHOT_BYTES = 6 * 1024 * 1024;    // 载荷（密文）上限
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;     // base64 请求体上限（已实测可上传）
export const UPLOAD_RETRY = 3;
export const UPLOAD_RETRY_BACKOFF_MS = [1000, 4000, 10000];
export const AUTO_UPLOAD = false;

/** 网络 */
export const GITEE_API_BASE = 'https://gitee.com/api/v5';
export const REQUEST_TIMEOUT_MS = 30000;

/** 仓库路径约定 */
export const KEYFILE_PATH = 'keyfile.json';
export const BACKUPS_DIR = 'backups';

/** 本地存储键（storage.local 中的键名） */
export const STORE_KEYS = {
  giteeOwner: 'gitee_owner',
  giteeRepo: 'gitee_repo',
  pat: 'pat',
  machineName: 'machine_name',
  /** 本机唯一标识：首次使用时生成一次，永不变。用于识别"重名但是两台机器" */
  machineId: 'machine_id',
  /** 「信任此设备」的有效期（天）。0 或缺失 = 关闭 */
  rememberDays: 'remember_days',
  /** 设备密钥（不可导出的 CryptoKey，用于加密记住的口令） */
  deviceKey: 'device_key',
  /** 记住的口令（被设备密钥加密后的密文）与最后使用时间 */
  rememberedPassword: 'remembered_password',
  /** 自动备份：开关与间隔（分钟） */
  autoBackup: 'auto_backup',
  autoBackupMinutes: 'auto_backup_minutes',
  /** 上次自动备份时间（用于界面显示） */
  lastAutoBackupAt: 'last_auto_backup_at',
  lastSnapshotId: 'last_snapshot_id',
  currentSource: 'current_source',
};

/** Crockford Base32 字母表：去除易混字符 0/O/1/I/L */
export const B32_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 设置备份白名单（v1）。
 *
 * 只包含 `browserSettings` 下**已被验证可读**的项。读不到的项不会写进快照，
 * 并在 `settings_unavailable` 里如实记录（绝不写猜测值或默认值）。
 *
 * 注意：这些项在不同 Firefox 版本上的可读/可写性会变化，
 * 因此实现必须逐项 try/catch，而不是假定它们都存在。
 */
export const BROWSER_SETTINGS_WHITELIST = [
  'homepageOverride',
  'newTabPageOverride',
  'imageAnimation',
  'javascriptEnabled',
  'allowPopupsForUserEvents',
  'cacheEnabled',
  'cookiesEnabled',
  'webNotificationsDisabled',
];

/**
 * `browser.privacy` 下的白名单。取自该 API 的文档子项，
 * 实际可否读取由运行时的 try/catch 决定。
 */
export const PRIVACY_WHITELIST = [
  'network.networkPredictionEnabled',
  'network.webRTCIPHandlingPolicy',
  'websites.hyperlinkAuditingEnabled',
  'websites.referrersEnabled',
  'websites.resistFingerprinting',
];

/** 由 BASE64 膨胀率推导：载荷上限对应的 base64 长度 */
export const base64Length = (byteLength) => Math.ceil(byteLength / 3) * 4;

/**
 * 存储里**所有**我们自己的键。
 *
 * 为什么需要这份清单：在 Firefox Nightly 159 上实测发现
 * **`storage.local.get(null)`（"读取全部"）返回空对象**，
 * 而 `get('某个键')` / `get([键1,键2])` 完全正常。
 *
 * 因此代码**不要依赖 `get(null)`** —— 改为按这份清单显式读取。
 * 这样既绕开了那个行为差异，也让"我们到底存了什么"一目了然。
 */
export const ALL_STORE_KEYS = Object.values(STORE_KEYS);
