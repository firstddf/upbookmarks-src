#!/usr/bin/env node
/**
 * V1–V8 验证脚本 —— 加解密与密钥管理
 *
 * 参数全部取自 docs/03-parameters.md。**未经 Gitee，纯本地**。
 * 目的：在写扩展之前证明「换设备一定能解开」。
 *
 * 用法：
 *   node tools/v1-v8-verify.mjs
 *   node tools/v1-v8-verify.mjs --keep-tmp      # 保留临时目录以便人工检查
 *
 * 退出码：0 = 全部通过；1 = 有断言失败。
 */

import { randomBytes, webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { subtle } = webcrypto;

// ---------------------------------------------------------------- 参数
// 全部来自 docs/03-parameters.md，此处不得引入文档外的常量。

const P = {
  CIPHER: 'AES-GCM',
  IV_BYTES: 12,
  DEK_BYTES: 32,
  KEK_BYTES: 32,
  GCM_TAG_BITS: 128,
  AAD_PREFIX: 'upbookmarks',
  WRAP_IV_BYTES: 12,

  KDF_PASSWORD_ALGO: 'PBKDF2-SHA256',
  KDF_PASSWORD_ITERATIONS: 600000,
  KDF_PASSWORD_SALT_BYTES: 16,

  KDF_RECOVERY_ALGO: 'HKDF-SHA256',
  KDF_RECOVERY_INFO: 'upbookmarks/recovery-key/v1',
  KDF_RECOVERY_SALT_BYTES: 16,
  RECOVERY_CODE_BITS: 160,

  KEYFILE_FORMAT: 'upbookmarks/keyfile',
  SNAPSHOT_FORMAT: 'upbookmarks/snapshot',
  INDEX_FORMAT: 'upbookmarks/index',
  FORMAT_VERSION: 1,
};

const KEYFILE_PATH = 'keyfile.json';
const SNAPSHOT_NAME = '20260214T103000Z.enc';
const MACHINE = 'desktop';

// Crockford Base32：去除易混字符 0/O/1/I/L
const B32_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

// ---------------------------------------------------------------- 工具

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const utf8 = (s) => new TextEncoder().encode(s);
const fromUtf8 = (b) => new TextDecoder().decode(b);

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

/** 生成恢复码：160 bit 随机 + Base32 + 分组便于抄写 */
function generateRecoveryCode() {
  const bytes = randomBytes(P.RECOVERY_CODE_BITS / 8);
  const s = base32Encode(bytes);
  return s.match(/.{1,5}/g).join('-');
}

/** 规范化恢复码：只保留字母，统一大写（去掉分组符与空白） */
const normalizeRecoveryCode = (code) => code.replace(/[^0-9A-Za-z]/g, '').toUpperCase();

// ---------------------------------------------------------------- 加密原语

async function deriveKekFromPassword(password, salt) {
  const base = await subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: P.KDF_PASSWORD_ITERATIONS,
      hash: 'SHA-256',
    },
    base,
    { name: P.CIPHER, length: P.KEK_BYTES * 8 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

async function deriveKekFromRecoveryCode(code, salt) {
  const base = await subtle.importKey('raw', utf8(normalizeRecoveryCode(code)), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: utf8(P.KDF_RECOVERY_INFO),
    },
    base,
    { name: P.CIPHER, length: P.KEK_BYTES * 8 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/** 用 KEK 包裹 DEK（wrapKey 产出 = ciphertext‖tag，与快照格式无关） */
async function wrapDek(kek, dek) {
  const iv = randomBytes(P.WRAP_IV_BYTES);
  const wrapped = await subtle.wrapKey('raw', dek, kek, { name: P.CIPHER, iv, tagLength: P.GCM_TAG_BITS });
  return { iv_b64: b64(iv), wrapped_dek_b64: b64(wrapped) };
}

/**
 * 解包 DEK。
 *
 * `extractable` 只在验证脚本里为 true —— V2 需要导出两把 DEK 做逐字节比较。
 * **生产实现必须传 false**：扩展永远不需要导出 DEK，不导出就少一条泄漏路径。
 * 该标志不影响解密结果（本次验证的是格式与密钥管理，不是可导出性）。
 */
async function unwrapDek(kek, wrap, kekUsages, extractable = true) {
  return subtle.unwrapKey(
    'raw',
    unb64(wrap.wrapped_dek_b64),
    kek,
    { name: P.CIPHER, iv: unb64(wrap.iv_b64), tagLength: P.GCM_TAG_BITS },
    { name: P.CIPHER, length: P.DEK_BYTES * 8 },
    extractable,
    kekUsages,
  );
}

const aadFor = (formatVersion, machine, snapshotId) =>
  utf8(`${P.AAD_PREFIX}|${formatVersion}|${machine}|${snapshotId}`);

/** 加密快照：输出单行 base64(IV‖ciphertext‖tag)，与 docs/04 一致 */
async function encryptSnapshot(dek, plaintextObj, machine, snapshotId) {
  const iv = randomBytes(P.IV_BYTES);
  const ct = await subtle.encrypt(
    { name: P.CIPHER, iv, tagLength: P.GCM_TAG_BITS, additionalData: aadFor(P.FORMAT_VERSION, machine, snapshotId) },
    dek,
    utf8(JSON.stringify(plaintextObj)),
  );
  return b64(Buffer.concat([iv, Buffer.from(ct)]));
}

async function decryptSnapshot(dek, encText, machine, snapshotId) {
  const raw = Buffer.from(encText.trim(), 'base64');
  const iv = raw.subarray(0, P.IV_BYTES);
  const ct = raw.subarray(P.IV_BYTES);
  const pt = await subtle.decrypt(
    { name: P.CIPHER, iv, tagLength: P.GCM_TAG_BITS, additionalData: aadFor(P.FORMAT_VERSION, machine, snapshotId) },
    dek,
    ct,
  );
  return JSON.parse(fromUtf8(new Uint8Array(pt)));
}

// ---------------------------------------------------------------- 断言

const results = [];
function check(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} · ${title}${ok ? '' : `\n        ${detail}`}`);
}

// ---------------------------------------------------------------- 流程

/** 模拟「建立仓库」：生成 DEK，用两种方式各包裹一次 */
async function buildKeyfile(password, recoveryCode) {
  const dek = await subtle.generateKey({ name: P.CIPHER, length: P.DEK_BYTES * 8 }, true, [
    'encrypt',
    'decrypt',
  ]);

  const pwdSalt = randomBytes(P.KDF_PASSWORD_SALT_BYTES);
  const kekPwd = await deriveKekFromPassword(password, pwdSalt);
  const wPwd = await wrapDek(kekPwd, dek);

  const recSalt = randomBytes(P.KDF_RECOVERY_SALT_BYTES);
  const kekRec = await deriveKekFromRecoveryCode(recoveryCode, recSalt);
  const wRec = await wrapDek(kekRec, dek);

  const keyfile = {
    format: P.KEYFILE_FORMAT,
    format_version: P.FORMAT_VERSION,
    created_at: new Date().toISOString(),
    wraps: [
      {
        method: 'password',
        kdf: {
          algo: P.KDF_PASSWORD_ALGO,
          iterations: P.KDF_PASSWORD_ITERATIONS,
          salt_b64: b64(pwdSalt),
        },
        iv_b64: wPwd.iv_b64,
        wrapped_dek_b64: wPwd.wrapped_dek_b64,
      },
      {
        method: 'recovery',
        kdf: { algo: P.KDF_RECOVERY_ALGO, salt_b64: b64(recSalt) },
        iv_b64: wRec.iv_b64,
        wrapped_dek_b64: wRec.wrapped_dek_b64,
      },
    ],
  };
  return { dek, keyfile };
}

/** 模拟「新设备」：只有 keyfile 内容 + 用户输入的凭据，不得依赖任何本地状态 */
async function unlockFromKeyfile(keyfile, { password, recoveryCode }) {
  const wrap = password
    ? keyfile.wraps.find((w) => w.method === 'password')
    : keyfile.wraps.find((w) => w.method === 'recovery');
  if (!wrap) throw new Error(`keyfile 中没有 ${password ? 'password' : 'recovery'} 包裹项`);

  let kek;
  if (password) {
    if (wrap.kdf.algo !== P.KDF_PASSWORD_ALGO) throw new Error(`KDF 不符: ${wrap.kdf.algo}`);
    kek = await deriveKekFromPassword(password, unb64(wrap.kdf.salt_b64));
  } else {
    if (wrap.kdf.algo !== P.KDF_RECOVERY_ALGO) throw new Error(`KDF 不符: ${wrap.kdf.algo}`);
    kek = await deriveKekFromRecoveryCode(recoveryCode, unb64(wrap.kdf.salt_b64));
  }
  return unwrapDek(kek, wrap, ['encrypt', 'decrypt']);
}

const samplePayload = () => ({
  bookmarks: {
    children: [
      {
        title: '书签栏',
        children: [
          { title: '示例', url: 'https://example.com/', dateAdded: 1739000000000 },
          { title: '中文标题 · 测试', url: 'https://example.org/中文', dateAdded: 1739000000001 },
        ],
      },
    ],
  },
  settings: { homepageOverride: 'https://example.com/' },
  settings_unavailable: [],
  settings_platform_note: 'firefox',
});

async function main() {
  const keepTmp = process.argv.includes('--keep-tmp');
  const workRoot = await mkdtemp(join(tmpdir(), 'upbookmarks-v1v8-'));
  const machineA = join(workRoot, 'deviceA');
  const machineB = join(workRoot, 'deviceB');
  const repo = join(workRoot, 'fake-gitee-repo'); // 模拟「云端仓库」
  await mkdir(machineA, { recursive: true });
  await mkdir(machineB, { recursive: true });
  await mkdir(join(repo, 'backups', MACHINE), { recursive: true });

  console.log(`工作目录: ${workRoot}\n`);

  const PASSWORD = '赤脚-沙滩-七月的-不穿鞋-海风-咸';   // 口令短语（示例，真实使用需随机生成）
  const RECOVERY = generateRecoveryCode();

  // ---- 建立仓库
  const { keyfile } = await buildKeyfile(PASSWORD, RECOVERY);
  await writeFile(join(repo, KEYFILE_PATH), JSON.stringify(keyfile, null, 2));
  const payload = samplePayload();

  // ---- A 机上传
  const dekA = await unlockFromKeyfile(keyfile, { password: PASSWORD });
  const enc = await encryptSnapshot(dekA, payload, MACHINE, SNAPSHOT_NAME);
  await writeFile(join(repo, 'backups', MACHINE, SNAPSHOT_NAME), enc);
  await writeFile(
    join(repo, 'backups', MACHINE, 'index.json'),
    JSON.stringify(
      {
        format: P.INDEX_FORMAT,
        format_version: P.FORMAT_VERSION,
        machine: MACHINE,
        snapshots: [
          {
            id: SNAPSHOT_NAME.replace('.enc', ''),
            file: SNAPSHOT_NAME,
            created_at: '2026-02-14T10:30:00Z',
            bytes: enc.length,
            sha: null,
          },
        ],
      },
      null,
      2,
    ),
  );

  // ============================================================ V1
  const roundTrip = await decryptSnapshot(dekA, enc, MACHINE, SNAPSHOT_NAME);
  check(
    'V1',
    '往返正确：加密后解密得到相同 JSON',
    JSON.stringify(roundTrip) === JSON.stringify(payload),
    `得到 ${JSON.stringify(roundTrip).slice(0, 120)}`,
  );

  // ============================================================ V2
  const dekFromRecovery = await unlockFromKeyfile(keyfile, { recoveryCode: RECOVERY });
  const dekFromRecoveryRaw = new Uint8Array(await subtle.exportKey('raw', dekFromRecovery));
  const dekARaw = new Uint8Array(await subtle.exportKey('raw', dekA));
  const sameDek = Buffer.from(dekFromRecoveryRaw).equals(Buffer.from(dekARaw));
  let recoveryDecrypts = false;
  try {
    recoveryDecrypts =
      JSON.stringify(await decryptSnapshot(dekFromRecovery, enc, MACHINE, SNAPSHOT_NAME)) ===
      JSON.stringify(payload);
  } catch { /* 保持 false */ }
  check(
    'V2',
    '两条路径同源：主口令与恢复码解出同一把 DEK',
    sameDek && recoveryDecrypts,
    `sameDek=${sameDek} recoveryDecrypts=${recoveryDecrypts}`,
  );

  // ============================================================ V3
  // 干净环境：把仓库内容复制到 machineB 的视角，不复制任何本地状态或密钥文件
  await writeFile(join(machineB, 'note.txt'), '本目录只有模拟的云端内容，没有任何本地密钥状态');
  const keyfileFromRepo = JSON.parse(await readFile(join(repo, KEYFILE_PATH), 'utf8'));
  const encFromRepo = await readFile(join(repo, 'backups', MACHINE, SNAPSHOT_NAME), 'utf8');
  const dekB = await unlockFromKeyfile(keyfileFromRepo, { password: PASSWORD });
  let cleanEnvOk = false;
  let cleanEnvDetail = '';
  try {
    const restored = await decryptSnapshot(dekB, encFromRepo, MACHINE, SNAPSHOT_NAME);
    cleanEnvOk = JSON.stringify(restored) === JSON.stringify(payload);
    cleanEnvDetail = `还原书签组数=${restored.bookmarks.children.length}`;
  } catch (e) {
    cleanEnvDetail = `失败: ${e.message}`;
  }
  check('V3', '干净环境可解：仅凭主口令 + 仓库内容还原', cleanEnvOk, cleanEnvDetail);

  // ============================================================ V4
  const raw = Buffer.from(enc, 'base64');
  const tampered = Buffer.from(raw);
  tampered[tampered.length - 1] ^= 0x01; // 翻转 tag 的最后一 bit
  let v4Rejected = false;
  try {
    await decryptSnapshot(dekA, tampered.toString('base64'), MACHINE, SNAPSHOT_NAME);
  } catch { v4Rejected = true; }
  check('V4', '篡改必失败：改动密文任意一字节 → GCM 校验失败', v4Rejected, '竟然解密成功了');

  // ============================================================ V5
  // 换位攻击：把 desktop 的快照当成 laptop 的解（AAD 里的 machine 不同）
  let v5Rejected = false;
  try {
    await decryptSnapshot(dekA, enc, 'laptop', SNAPSHOT_NAME);
  } catch { v5Rejected = true; }
  // 再试换 snapshot_id
  let v5bRejected = false;
  try {
    await decryptSnapshot(dekA, enc, MACHINE, '20260101T000000Z');
  } catch { v5bRejected = true; }
  check(
    'V5',
    '换位必失败：machine 或 snapshot_id 被改 → AAD 校验失败',
    v5Rejected && v5bRejected,
    `换 machine 被拒=${v5Rejected} 换 snapshot_id 被拒=${v5bRejected}`,
  );

  // ============================================================ V6
  // 参数自描述：只用 keyfile 的字段（不借助脚本里的常量）重建 KEK
  let v6Ok = false;
  let v6Detail = '';
  try {
    const w = keyfile.wraps.find((x) => x.method === 'password');
    const kek = await subtle.deriveKey(
      { name: 'PBKDF2', salt: unb64(w.kdf.salt_b64), iterations: w.kdf.iterations, hash: 'SHA-256' },
      await subtle.importKey('raw', utf8(PASSWORD), 'PBKDF2', false, ['deriveKey']),
      { name: P.CIPHER, length: P.KEK_BYTES * 8 },
      false,
      ['unwrapKey'],
    );
    const dek = await subtle.unwrapKey(
      'raw',
      unb64(w.wrapped_dek_b64),
      kek,
      { name: P.CIPHER, iv: unb64(w.iv_b64), tagLength: P.GCM_TAG_BITS },
      { name: P.CIPHER, length: P.DEK_BYTES * 8 },
      true, // 仅验证脚本需要导出比较；生产实现为 false
      ['decrypt'],
    );
    const got = Buffer.from(new Uint8Array(await subtle.exportKey('raw', dek))).toString('hex');
    const want = Buffer.from(dekARaw).toString('hex');
    v6Ok = got === want;
    v6Detail = `algo=${w.kdf.algo} iterations=${w.kdf.iterations} 自描述重建=${v6Ok}`;
  } catch (e) {
    v6Detail = e.message;
  }
  check('V6', '参数自描述：仅凭 keyfile 字段即可重建 KEK', v6Ok, v6Detail);

  // ============================================================ V7
  const NEW_PASSWORD = '新的-口令-短语-六个词-以上-用于轮换';
  const newSalt = randomBytes(P.KDF_PASSWORD_SALT_BYTES);
  const kekNew = await deriveKekFromPassword(NEW_PASSWORD, newSalt);
  const wNew = await wrapDek(kekNew, dekA); // 用同一把 DEK 重新包裹
  const keyfile2 = {
    ...keyfile,
    wraps: [
      { method: 'password', kdf: { algo: P.KDF_PASSWORD_ALGO, iterations: P.KDF_PASSWORD_ITERATIONS, salt_b64: b64(newSalt) }, ...wNew },
      keyfile.wraps.find((w) => w.method === 'recovery'),
    ],
  };
  const dekAfterRotate = await unlockFromKeyfile(keyfile2, { password: NEW_PASSWORD });
  let oldSnapshotStillReadable = false;
  try {
    oldSnapshotStillReadable =
      JSON.stringify(await decryptSnapshot(dekAfterRotate, enc, MACHINE, SNAPSHOT_NAME)) ===
      JSON.stringify(payload);
  } catch { /* 保持 false */ }
  // 旧口令必须失效
  let oldPasswordFails = false;
  try {
    const bad = await unlockFromKeyfile(keyfile2, { password: PASSWORD });
    await decryptSnapshot(bad, enc, MACHINE, SNAPSHOT_NAME);
  } catch { oldPasswordFails = true; }
  check(
    'V7',
    '改主口令不破坏历史：换口令后旧快照仍可解、旧口令失效',
    oldSnapshotStillReadable && oldPasswordFails,
    `旧快照可读=${oldSnapshotStillReadable} 旧口令已失效=${oldPasswordFails}`,
  );

  // ============================================================ V8
  const t0 = performance.now();
  await deriveKekFromPassword(PASSWORD, newSalt);
  const tPwd = performance.now() - t0;
  const t1 = performance.now();
  await deriveKekFromRecoveryCode(RECOVERY, newSalt);
  const tRec = performance.now() - t1;
  check(
    'V8',
    '性能可接受：主口令 ≤2000ms，恢复码 <100ms',
    tPwd <= 2000 && tRec < 100,
    `PBKDF2(${P.KDF_PASSWORD_ITERATIONS}) = ${tPwd.toFixed(0)}ms ; HKDF = ${tRec.toFixed(1)}ms`,
  );

  // ---------------------------------------------------------------- 小结
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(64));
  console.log(`小结: PASS=${results.length - failed.length}  FAIL=${failed.length}`);
  console.log(`恢复码长度: ${RECOVERY.length} 字符（含分组符），${normalizeRecoveryCode(RECOVERY).length} 位有效字符`);
  console.log(`单个快照密文: ${enc.length} 字节（明文 ${JSON.stringify(payload).length} 字节）`);
  console.log('='.repeat(64));

  const reportPath = join(dirname(fileURLToPath(import.meta.url)), 'out', 'v1-v8-report.json');
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        passwordPathMs: Math.round(tPwd),
        recoveryPathMs: Number(tRec.toFixed(2)),
        ciphertextBytes: enc.length,
        plaintextBytes: JSON.stringify(payload).length,
        summary: { pass: results.length - failed.length, fail: failed.length },
        results,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`报告已写入: ${reportPath}`);

  if (!keepTmp) await rm(workRoot, { recursive: true, force: true });
  else console.log(`临时目录保留: ${workRoot}`);

  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error('验证脚本异常终止:', e);
  process.exitCode = 2;
});
