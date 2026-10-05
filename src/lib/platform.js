/**
 * 平台适配层 —— 唯一直接接触 `browser` / `chrome` 全局的地方
 *
 * 这一层刻意做得很薄：所有逻辑都在 src/lib/ 下，本文件只负责
 *   1. 取到 API 命名空间（Firefox 有 `browser`，Chromium 历史上只有 `chrome`）；
 *   2. 探测某平台**是否真的支持**某能力（例如 Chrome 没有 browserSettings）；
 *   3. 把各 API 包成各 lib 模块期望的形状。
 *
 * 注意：本文件在 Node 里 import 不会报错，但 `getApi()` 会返回 null，
 * 因此测试不要直接用它，而是用各 lib 模块 + 假适配器。
 */

import { ALL_STORE_KEYS } from './constants.js';

/** 取 API 命名空间。Firefox 用 browser，Chromium 用 chrome（新版也有 browser）。 */
export function getApi() {
  if (typeof globalThis.browser !== 'undefined' && globalThis.browser?.runtime) return globalThis.browser;
  if (typeof globalThis.chrome !== 'undefined' && globalThis.chrome?.runtime) return globalThis.chrome;
  return null;
}

export function requireApi() {
  const api = getApi();
  if (!api) throw new Error('取不到扩展 API 命名空间（不在扩展环境里？）');
  return api;
}

/** 识别当前浏览器：'firefox' | 'chromium' */
export function detectPlatform(api = getApi()) {
  if (!api) return 'unknown';
  const ua = globalThis.navigator?.userAgent ?? '';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrom(e|ium)|Edg\//.test(ua)) return 'chromium';
  return api.browserSettings ? 'firefox' : 'chromium';
}

/** Firefox 的 BrowserSetting 是 { get({}) }，Chromium 没有这一套 */
export function hasBrowserSettings(api = getApi()) {
  return Boolean(api?.browserSettings);
}

export function hasPrivacy(api = getApi()) {
  return Boolean(api?.privacy);
}

// ---------------------------------------------------------------- 子适配器

/** 书签 API，形状与 collect.js / restore.js 的期望一致 */
export function bookmarksAdapter(api = requireApi()) {
  const b = api.bookmarks;
  if (!b) throw new Error('没有 bookmarks 权限');
  return {
    getTree: () => b.getTree(),
    getSubTree: (id) => b.getSubTree(id),
    get: (id) => b.get(id),
    create: (details) => b.create(details),
    removeTree: (id) => b.removeTree(id),
    searchTitle: (title) => (typeof b.search === 'function'
      ? b.search({ title })
      : Promise.resolve([])),
  };
}

/** 设置 API；不支持的平台返回 null，由 collect.js 记成平台说明 */
export function settingsAdapter(api = requireApi()) {
  if (!hasBrowserSettings(api) && !hasPrivacy(api)) {
    return { browserSettings: null, privacy: null };
  }
  return {
    browserSettings: api.browserSettings ?? null,
    privacy: api.privacy ?? null,
  };
}

/** storage.local 适配器 */
export function storageAdapter(api = requireApi()) {
  const s = api.storage?.local;
  if (!s) throw new Error('没有 storage 权限');
  return {
    get: (keys) => s.get(keys),
    set: (obj) => s.set(obj),
    remove: (keys) => s.remove(keys),
    clear: () => s.clear(),

    /**
     * 「读取全部」的稳健实现。
     *
     * 为什么不能直接用 `get(null)`：**Firefox Nightly 159 实测该调用返回空对象**，
     * 而按具体键读取完全正常（见 tests/ 与 docs 里的记录）。
     * 因此这里先试标准的 `get(null)`，若结果为空再按已知键显式读取，
     * 两者取并集 —— 对"标准行为"和"该异常行为"都正确。
     */
    async getAll() {
      let viaNull = {};
      try {
        viaNull = (await s.get(null)) ?? {};
      } catch { viaNull = {}; }

      // 先按扩展自己关心的键补齐（这一步在异常行为下是关键）
      let byKnownKeys = {};
      try {
        byKnownKeys = (await s.get(ALL_STORE_KEYS)) ?? {};
      } catch { byKnownKeys = {}; }

      // 以 get(null) 为主（能拿到非本扩展的键），再用按需读取补齐缺口
      return { ...byKnownKeys, ...viaNull };
    },
  };
}

/**
 * 读取我们自己的全部配置项。
 *
 * **刻意逐个键读取**，既不用 `get(null)`，也不一次传整个键名数组：
 * 在本机 Firefox Nightly 159 上实测到
 *   - `get(null)` / `get()` / `get([])` / `get({})` → 一律返回空对象；
 *   - `get(['少数几个键'])` → 正常；
 *   - `get([13 个键])` → **也返回空**；
 *   - `get('单个键')` → 始终正常。
 *
 * 因此这里取最保守、实测最稳的模式：**一次只读一个键**。
 * 代价是 N 次调用，但配置项只有十几个，完全可接受。
 */
export async function readAllConfig(api = requireApi()) {
  const s = storageAdapter(api);
  const out = {};
  for (const key of ALL_STORE_KEYS) {
    try {
      const r = await s.get(key);
      if (r && r[key] !== undefined) out[key] = r[key];
    } catch {
      // 单个键读取失败不应让整体失败
    }
  }
  return out;
}

/**
 * storage.session 适配器 —— 用于「本次浏览器会话内免输口令」。
 *
 * `storage.session` 的内容**只存在于内存**，浏览器关闭即消失，不落磁盘。
 * 不可用时返回 null（调用方降级为"每次都要输"）。
 */
export function sessionAdapter(api = requireApi()) {
  const s = api.storage?.session;
  if (!s) return null;
  return {
    get: (keys) => s.get(keys),
    set: (obj) => s.set(obj),
    remove: (keys) => s.remove(keys),
    /** 会话存储本身不做过期，这里只为与持久层接口一致（不活动过期的逻辑在持久层） */
    async touch() { /* no-op */ },
  };
}

/**
 * 设备本地密钥 —— 用于把"记住的口令"加密后再落盘。
 *
 * 关键在于 **`extractable: false`**：这把 CryptoKey 交给浏览器后，
 * **没有任何 API 能把它导出**（`exportKey` 会抛错）。因此即使有人读走了
 * `storage.local` 的 JSON 文件，拿到的也只是**密文**，而解密所需的密钥
 * 存在于浏览器内部，取不出来。
 *
 * 它是一条**折中**，边界必须说清楚：
 *   - 挡得住：读文件（profile 目录被复制、备份被翻、同机其他程序扫文件）；
 *   - 挡不住：以本扩展身份执行代码（那种情况下它可以命令浏览器解密）。
 *
 * 这不是端到端加密，只是"不让密钥以明文躺在磁盘上"。
 */
export async function getOrCreateDeviceKey(api = requireApi()) {
  const s = storageAdapter(api);
  const KEY = 'device_key';

  const existing = await s.get(KEY);
  if (existing?.[KEY]) {
    // 兼容旧记录：若被存成了可导出的，仍然接受（但下次会以不可导出重建）
    return existing[KEY];
  }

  const key = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,                       // ← 不可导出：这是本方案的安全支点
    ['encrypt', 'decrypt'],
  );
  await s.set({ [KEY]: key });
  return key;
}

/** 用设备密钥加密一段文本，返回可落盘的记录 */
export async function encryptForDevice(api, plaintext) {
  const key = await getOrCreateDeviceKey(api);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(String(plaintext)),
  );
  const toB64 = (u8) => {
    let s = '';
    for (const b of u8) s += String.fromCharCode(b);
    return btoa(s);
  };
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

/** 用设备密钥解密；失败返回 null（例如设备密钥被清过） */
export async function decryptForDevice(api, record) {
  if (!record?.iv || !record?.ct) return null;
  try {
    const key = await getOrCreateDeviceKey(api);
    const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const pt = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(record.iv) },
      key,
      fromB64(record.ct),
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;                 // 密钥换了/记录损坏 → 当作没有记住
  }
}

/**
 * 「信任此设备」存储：把口令用设备密钥加密后写进 `storage.local`。
 *
 * 关于 `storage.local` 里有 CryptoKey 这件事：Firefox 会把它按结构化克隆
 * 序列化保存。因为**不可导出**，读文件的人只能得到密文；
 * 而要解密必须让浏览器把密钥交给扩展代码 —— 那需要已经能在本扩展上下文里执行代码。
 */
export function persistentSessionAdapter(api = requireApi()) {
  const s = storageAdapter(api);

  /** 读单个记录 + 有效期设置（不用 get(null)，见 readAllConfig 的说明） */
  async function readRecord(key) {
    const got = (await s.get([key, 'remember_days'])) ?? {};
    return { rec: got[key], days: Number(got.remember_days ?? 0) };
  }

  return {
    async get(key) {
      const { rec, days } = await readRecord(key);
      if (!rec?.value) return {};
      // 不活动过期检查在这里做，而不是让调用方判断
      if (!days || days <= 0) return {};
      const last = rec.lastUsedAt ?? 0;
      const ageMs = Date.now() - last;
      if (ageMs > days * 24 * 60 * 60 * 1000) {
        await s.remove(key);
        return {};
      }
      const plain = await decryptForDevice(api, rec.value);
      if (!plain) { await s.remove(key); return {}; }
      return { [key]: plain };
    },

    async set(obj) {
      for (const [k, v] of Object.entries(obj)) {
        const value = await encryptForDevice(api, v);
        await s.set({ [k]: { value, lastUsedAt: Date.now() } });
      }
    },

    /** 每次成功使用都刷新"最后使用时间"（不活动才过期，不是绝对过期） */
    async touch(key) {
      const { rec } = await readRecord(key);
      if (rec) await s.set({ [key]: { ...rec, lastUsedAt: Date.now() } });
    },

    async remove(key) {
      await s.remove(key);
    },
  };
}

/** 取/存扩展配置（PAT、机器名等） */
export function configStore(api = requireApi()) {
  const s = storageAdapter(api);
  return {
    /**
     * 读取配置。
     * **不用 `get(null)`** —— 该写法在 Firefox Nightly 上返回空对象（实测）。
     * 改为按 ALL_STORE_KEYS 显式读取，行为稳定且可预期。
     */
    async read() {
      return readAllConfig(api);
    },
    async write(patch) {
      await s.set(patch);
    },
  };
}

/**
 * 返回一个 fetch 实现。扩展有 host 权限时，`fetch` 不受跨域限制，
 * 因此直接用全局 fetch 即可。
 */
export function httpFetch() {
  if (typeof globalThis.fetch !== 'function') throw new Error('当前环境没有 fetch');
  return globalThis.fetch;
}

/** 环境自述，用于 UI 上如实展示能力边界 */
export function describeCapabilities(api = getApi()) {
  const platform = detectPlatform(api);
  return {
    platform,
    canBackupBookmarks: Boolean(api?.bookmarks),
    canBackupSettings: hasBrowserSettings(api),
    canBackupPrivacy: hasPrivacy(api),
    note: hasBrowserSettings(api)
      ? null
      : `${platform}:no-browserSettings —— 此平台只能备份书签，浏览器设置读不到`,
  };
}
