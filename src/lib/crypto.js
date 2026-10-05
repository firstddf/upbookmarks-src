/**
 * 加密与密钥管理 —— 对应 docs/02-design.md 的「密钥分层」
 *
 * 本模块**不依赖任何浏览器或 Node 专有 API**：只用 crypto.subtle / TextEncoder /
 * Uint8Array / crypto.getRandomValues，因此可以在 Node 里直接 import 验证。
 *
 * 实现的参数与文档一致，并已通过 tools/crypto-consistency 在
 * Node / Chrome / Firefox 三处逐字节对拍（11/11 相同）。
 */

import {
  CIPHER,
  IV_BYTES,
  DEK_BYTES,
  KEK_BYTES,
  GCM_TAG_BITS,
  AAD_PREFIX,
  WRAP_IV_BYTES,
  KDF_PASSWORD_ITERATIONS,
  KDF_PASSWORD_SALT_BYTES,
  KDF_RECOVERY_INFO,
  KDF_RECOVERY_SALT_BYTES,
  RECOVERY_CODE_BITS,
  KEYFILE_FORMAT,
  FORMAT_VERSION,
  B32_ALPHABET,
} from './constants.js';

const subtle = globalThis.crypto.subtle;
const utf8 = (s) => new TextEncoder().encode(s);
const fromUtf8 = (b) => new TextDecoder().decode(b);

// ---------------------------------------------------------------- 字节工具

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// ---------------------------------------------------------------- Base32（恢复码）

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * 生成恢复码：160 bit 随机 → Base32 → 每 5 字符一组。
 * 只显示一次，由调用方负责要求用户当场抄写。
 */
export function generateRecoveryCode() {
  const raw = randomBytes(RECOVERY_CODE_BITS / 8);
  return base32Encode(raw).match(/.{1,5}/g).join('-');
}

/** 规范化用户输入的恢复码：去掉分组符与空白，统一大写 */
export function normalizeRecoveryCode(code) {
  return String(code).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

// ---------------------------------------------------------------- 密钥派生

/** 主口令 → KEK。慢 KDF，因为主口令熵低。 */
export async function deriveKekFromPassword(password, salt) {
  const base = await subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: KDF_PASSWORD_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: CIPHER, length: KEK_BYTES * 8 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/** 恢复码 → KEK。快 KDF，因为恢复码本身熵已足够（160 bit）。 */
export async function deriveKekFromRecoveryCode(code, salt) {
  const base = await subtle.importKey('raw', utf8(normalizeRecoveryCode(code)), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: utf8(KDF_RECOVERY_INFO) },
    base,
    { name: CIPHER, length: KEK_BYTES * 8 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

// ---------------------------------------------------------------- DEK 的生成与包裹

/**
 * 生成数据密钥。
 *
 * **`extractable` 必须为 true**：WebCrypto 的 `wrapKey` 要求被包裹的密钥可导出，
 * 否则无法把它装进 keyfile。这是把 DEK 交给调用方的那一小段窗口。
 *
 * 相对地，`unwrapDek` 产出的运行态 DEK 是 **不可导出** 的（见该函数），
 * 日常加解密用的都是那一把 —— 所以「不可导出」这条约束落在正确的位置。
 */
export async function generateDek(extractable = true) {
  return subtle.generateKey({ name: CIPHER, length: DEK_BYTES * 8 }, extractable, ['encrypt', 'decrypt']);
}

/** 用 KEK 包裹 DEK，返回可序列化的两项 */
export async function wrapDek(kek, dek) {
  const iv = randomBytes(WRAP_IV_BYTES);
  const wrapped = await subtle.wrapKey('raw', dek, kek, { name: CIPHER, iv, tagLength: GCM_TAG_BITS });
  return { iv_b64: bytesToBase64(iv), wrapped_dek_b64: bytesToBase64(wrapped) };
}

/**
 * 用 KEK 解开 DEK。
 * `extractable` 默认 false；验证脚本需要比较时传 true。
 */
export async function unwrapDek(kek, wrap, extractable = false) {
  return subtle.unwrapKey(
    'raw',
    base64ToBytes(wrap.wrapped_dek_b64),
    kek,
    { name: CIPHER, iv: base64ToBytes(wrap.iv_b64), tagLength: GCM_TAG_BITS },
    { name: CIPHER, length: DEK_BYTES * 8 },
    extractable,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------- 快照加解密

/** AAD 绑定格式版本、来源机器与快照 id，防止密文被换位 */
export function buildAad(formatVersion, machine, snapshotId) {
  return utf8(`${AAD_PREFIX}|${formatVersion}|${machine}|${snapshotId}`);
}

/**
 * 加密快照。返回 `base64(IV ‖ ciphertext‖tag)` 单行字符串，
 * 与 docs/04-repo-layout.md 的 `.enc` 格式一致。
 */
export async function encryptSnapshot(dek, plaintextObject, { machine, snapshotId, formatVersion = FORMAT_VERSION }) {
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle.encrypt(
    {
      name: CIPHER,
      iv,
      tagLength: GCM_TAG_BITS,
      additionalData: buildAad(formatVersion, machine, snapshotId),
    },
    dek,
    utf8(JSON.stringify(plaintextObject)),
  );
  return bytesToBase64(concatBytes(iv, new Uint8Array(ct)));
}

/** 解密快照。AAD 不匹配或密文被篡改时抛异常（AES-GCM 认证失败）。 */
export async function decryptSnapshot(dek, encText, { machine, snapshotId, formatVersion = FORMAT_VERSION }) {
  const raw = base64ToBytes(String(encText).trim());
  if (raw.length <= IV_BYTES) throw new Error('密文长度不足，无法包含 IV');
  const pt = await subtle.decrypt(
    {
      name: CIPHER,
      iv: raw.subarray(0, IV_BYTES),
      tagLength: GCM_TAG_BITS,
      additionalData: buildAad(formatVersion, machine, snapshotId),
    },
    dek,
    raw.subarray(IV_BYTES),
  );
  return JSON.parse(fromUtf8(new Uint8Array(pt)));
}

// ---------------------------------------------------------------- keyfile

/**
 * 建立新仓库：生成 DEK，并用主口令与恢复码各包裹一次。
 * 返回 { keyfile, dek }。调用方负责把 keyfile 上传、把 DEK 留在内存。
 */
export async function createKeyfile({ password, recoveryCode }) {
  if (!password) throw new Error('必须提供主口令');
  const dek = await generateDek();

  const wraps = [];
  {
    const salt = randomBytes(KDF_PASSWORD_SALT_BYTES);
    const kek = await deriveKekFromPassword(password, salt);
    const w = await wrapDek(kek, dek);
    wraps.push({
      method: 'password',
      kdf: { algo: 'PBKDF2-SHA256', iterations: KDF_PASSWORD_ITERATIONS, salt_b64: bytesToBase64(salt) },
      ...w,
    });
  }
  if (recoveryCode) {
    const salt = randomBytes(KDF_RECOVERY_SALT_BYTES);
    const kek = await deriveKekFromRecoveryCode(recoveryCode, salt);
    const w = await wrapDek(kek, dek);
    wraps.push({
      method: 'recovery',
      kdf: { algo: 'HKDF-SHA256', salt_b64: bytesToBase64(salt) },
      ...w,
    });
  }

  const keyfile = {
    format: KEYFILE_FORMAT,
    format_version: FORMAT_VERSION,
    created_at: new Date().toISOString(),
    wraps,
  };
  return { keyfile, dek };
}

/**
 * 共用的解锁实现。`extractable` 决定产出的 DEK 是否可导出。
 * 常规路径传 false；只有主口令轮换（需要 wrapKey）才传 true。
 */
async function unlockDek(keyfile, { password, recoveryCode }, extractable) {
  const want = password ? 'password' : 'recovery';
  const wrap = (keyfile?.wraps ?? []).find((w) => w.method === want);
  if (!wrap) throw new Error(`keyfile 中没有「${want}」包裹项`);

  let kek;
  if (want === 'password') {
    kek = await deriveKekFromPassword(password, base64ToBytes(wrap.kdf.salt_b64));
  } else {
    kek = await deriveKekFromRecoveryCode(recoveryCode, base64ToBytes(wrap.kdf.salt_b64));
  }
  return unwrapDek(kek, wrap, extractable);
}

/**
 * 从 keyfile 解开 DEK —— 这是「新设备」路径：只需要 keyfile 内容和用户输入的凭据，
 * 不依赖任何本地状态。参数从 keyfile 自带的 kdf 字段读取（自描述）。
 *
 * 产出的 DEK **不可导出**（生产约束）。
 */
export async function unlockDekFromKeyfile(keyfile, { password, recoveryCode }) {
  return unlockDek(keyfile, { password, recoveryCode }, false);
}

/**
 * 与 `unlockDekFromKeyfile` 相同，但产出**可导出**的 DEK。
 *
 * **唯一用途是主口令轮换**：WebCrypto 的 `wrapKey` 只能包裹可导出的密钥，
 * 而运行态 DEK 刻意不可导出。调用方必须在用完即弃的范围内使用它，
 * 不要把它当作常规解锁路径（否则等于给自己开了一条导出通道）。
 */
export async function unlockDekForRewrap(keyfile, { password, recoveryCode }) {
  return unlockDek(keyfile, { password, recoveryCode }, true);
}

/**
 * 轮换主口令：用新口令重新包裹**同一把 DEK**，历史快照因此无需重加密。
 * 返回新的 keyfile（不修改入参）。
 */
export async function rewrapWithNewPassword(keyfile, dek, newPassword) {
  const salt = randomBytes(KDF_PASSWORD_SALT_BYTES);
  const kek = await deriveKekFromPassword(newPassword, salt);
  const w = await wrapDek(kek, dek);
  const others = (keyfile.wraps ?? []).filter((x) => x.method !== 'password');
  return {
    ...keyfile,
    wraps: [
      {
        method: 'password',
        kdf: { algo: 'PBKDF2-SHA256', iterations: KDF_PASSWORD_ITERATIONS, salt_b64: bytesToBase64(salt) },
        ...w,
      },
      ...others,
    ],
  };
}

// ---------------------------------------------------------------- 主口令强度

/**
 * 口令短语的分隔符。
 *
 * 除了英文的空格与短横，还接受中文里很自然的 `、，。；：·／` 等。
 * 之前只认空格/短横，导致中文用户按习惯敲的口令被判成"1 段"而被拒 —— 这是实现缺陷，不是用户的问题。
 */
const WORD_SEPARATORS = /[\s\-_.,;:/+·、，。；：！？!?|\\（）()【】\[\]《》]+/;

/**
 * 主口令强度门槛。**这里改，UI 的说明文字会自动跟着变**（见 passwordRequirementText）。
 *
 * 为什么用「段数 + 每段最少字符」而不是「总长度」：
 *
 * 熵是按**段**来的（每段取自一个候选集合），不是按字符来的。
 * 「猫 狗 鱼 鸟 山 水」和「咖啡 雨伞 铁轨 沙滩 口琴 风筝」段数相同、字符数差一倍，
 * 但前者的强度问题在于**每段太短**，而不是总长度不够。
 * 旧的「总长度 ≥16」既拦不住 6 段各 1 个字，又会误伤合理的短段。
 */
export const PASSWORD_STRENGTH = {
  minWords: 6,
  minSegmentChars: 2,
  /** 非中文场景下的兜底：总长度也不该太短。中文按汉字算 1 个字符，所以这个值不设太高。 */
  minTotalLength: 12,
};

/**
 * 按**码点**数长度。
 *
 * 不能用 `String.length`：它数的是 UTF-16 码元，emoji 与部分生僻字会被算成 2。
 * 中文常用字在 BMP 内是 1，但那属于巧合——按码点数才是"用户眼中的字符数"。
 */
const codePointLength = (s) => [...String(s)].length;

/**
 * 粗略评估主口令是否为「口令短语」。
 *
 * 这是**启发式**，不是熵计算器。它的职责是拦住明显弱的口令
 * （`123456`、单段短词、每段一两个字），而不是精确量化强度。
 *
 * 注意：**中文短语的每段熵低于英文单词**（英文常用词表约 7776 词，中文用户
 * 实际会用的短语高度集中），所以中文用户建议 7–8 段而不是刚好 6 段。
 */
export function assessPasswordStrength(password, opts = {}) {
  const { minWords, minSegmentChars, minTotalLength } = { ...PASSWORD_STRENGTH, ...opts };
  const text = String(password ?? '');
  const segments = text.split(WORD_SEPARATORS).filter((s) => s.length > 0);
  const reasons = [];

  if (segments.length < minWords) {
    reasons.push(`至少需要 ${minWords} 段（用空格、短横、中文逗号/顿号分隔），当前 ${segments.length} 段`);
  }
  const tooShort = segments.filter((s) => codePointLength(s) < minSegmentChars);
  if (tooShort.length > 0) {
    reasons.push(`有 ${tooShort.length} 段少于 ${minSegmentChars} 个字符（如「${tooShort[0]}」）`);
  }
  const total = codePointLength(text);
  if (total < minTotalLength) {
    reasons.push(`总长度不足 ${minTotalLength} 个字符（当前 ${total}）`);
  }
  return { ok: reasons.length === 0, segments: segments.length, length: total, reasons };
}

/** 门槛的直白说明，直接渲染到界面上（避免"失败才知道条件"） */
export function passwordRequirementText() {
  const { minWords, minSegmentChars } = PASSWORD_STRENGTH;
  return `要求：至少 ${minWords} 段（可以更多），每段至少 ${minSegmentChars} 个字符。`
    + `分隔符可用空格、短横、下划线或中文标点（、，。；：）。段数比长度更重要。`;
}

/** 给 UI 用的一行提示，说明当前口令差在哪里 */
export function describePasswordStrength(password) {
  const r = assessPasswordStrength(password);
  const { minWords } = PASSWORD_STRENGTH;
  if (r.ok) {
    const advice = r.segments < 7 ? '（中文短语建议再加 1–2 段：单段熵低于英文单词）' : '';
    return { ok: true, text: `达标：${r.segments} 段 / ${r.length} 字符${advice}` };
  }
  return { ok: false, text: `还不行：${r.reasons.join('；')}` };
}

// ---------------------------------------------------------------- 结构化口令

/**
 * 分段输入的**固定分隔符**。
 *
 * 由程序插入，用户只负责"每一段是什么"。这样消灭了四类必然发生的错误：
 *   - 中文逗号 `，` 与英文逗号 `,` 看起来一样却是不同口令；
 *   - 顿号 `、` 与逗号混用；
 *   - 多打/少打空格、前后带空格；
 *   - 粘贴时混入不可见字符。
 *
 * 注意：**分隔符会原样参与密钥派生**（PBKDF2 的输入就是拼好的字符串），
 * 所以这个值一旦改，已建仓库的用户必须用**旧写法**才能解锁。
 * 因此它是个格式常量，不是可随意调整的偏好项。
 */
export const PASSWORD_SEGMENT_SEPARATOR = ' ';

/** 把若干段拼成主口令（跳过空白段；段内首尾空格也去掉） */
export function joinPasswordSegments(segments) {
  return (segments ?? [])
    .map((s) => String(s ?? '').trim())
    .filter((s) => s.length > 0)
    .join(PASSWORD_SEGMENT_SEPARATOR);
}

/** 把主口令拆回段（用于把已有口令回填到分段输入框） */
export function splitPasswordSegments(password) {
  return String(password ?? '')
    .split(WORD_SEPARATORS)
    .filter((s) => s.length > 0);
}
