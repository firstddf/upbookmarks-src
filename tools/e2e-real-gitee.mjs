#!/usr/bin/env node
/**
 * 阶段二收尾：真实端到端测试
 *
 * 与 v1-v8-verify.mjs 的区别：那份用的是本地假仓库（目录），
 * 这份用**真实 Gitee 私有仓库** —— 证明整套格式经过 HTTP + base64 +
 * Gitee 存储之后仍然完好，而不是只在本地文件系统上成立。
 *
 * 流程：
 *   1. 建一个临时私有仓库
 *   2. 模拟设备 A：生成 DEK + keyfile，加密快照，上传到 Gitee
 *   3. 模拟全新设备 B：**只拿到密码**，从 Gitee 取回 keyfile 与快照，解密还原
 *   4. 再模拟设备 C：**只拿到恢复码**，同样还原
 *   5. 校验还原内容与原内容逐字节一致
 *   6. 删除临时仓库
 *
 * 用法：
 *   $env:GITEE_TOKEN = '<令牌>'
 *   node tools/e2e-real-gitee.mjs
 *   node tools/e2e-real-gitee.mjs --keep-repo     # 保留仓库供人工检查
 */

import { randomBytes, createHash, webcrypto } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { subtle } = webcrypto;

const API_BASE = 'https://gitee.com/api/v5';
const TIMEOUT_MS = 120_000;
const TOKEN = process.env.GITEE_TOKEN;
const REPO_NAME = 'upbookmarks-e2e-tmp';

// ---- 参数（取自 docs/03-parameters.md）
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
const BACKUPS_DIR = 'backups';
const MACHINE = 'desktop';
const SNAPSHOT_ID = '20260214T103000Z';
const SNAPSHOT_PATH = `${BACKUPS_DIR}/${MACHINE}/${SNAPSHOT_ID}.enc`;
const B32 = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

// ---- 工具
const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const utf8 = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
const genRecovery = () => base32Encode(randomBytes(P.RECOVERY_CODE_BITS / 8)).match(/.{1,5}/g).join('-');
const normRecovery = (c) => c.replace(/[^0-9A-Za-z]/g, '').toUpperCase();

async function req(method, path, { query, body } = {}) {
  const url = new URL(API_BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  if (TOKEN) url.searchParams.set('access_token', TOKEN);
  const init = { method, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { http: res.status, body: text, json };
}
const contentsPath = (repo, path = '') => `/repos/${repo}/contents${path ? `/${path}` : ''}`;

/**
 * 按 docs/02-design.md 的判断顺序写入文件：GET 决定 POST 还是 PUT。
 * `raw` 必须是**要落盘的真实字节**（Buffer 或字符串按 UTF-8 处理）。
 * Gitee API 的 `content` 字段需要 base64，转换只在这一处发生，调用方不要预先编码。
 */
async function putFile(repo, path, raw, message) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  const content = buf.toString('base64');
  const existing = await req('GET', contentsPath(repo, path));
  const isFile = existing.json && !Array.isArray(existing.json) && existing.json.sha;
  if (isFile) {
    return req('PUT', contentsPath(repo, path), {
      body: { access_token: TOKEN, content, message, sha: existing.json.sha },
    });
  }
  return req('POST', contentsPath(repo, path), {
    body: { access_token: TOKEN, content, message },
  });
}

async function readFile(repo, path) {
  const r = await req('GET', contentsPath(repo, path));
  if (Array.isArray(r.json)) return { missing: true, http: r.http };
  if (!r.json?.content) return { missing: true, http: r.http, note: 'no content field' };
  return { text: Buffer.from(r.json.content, 'base64').toString('utf8'), sha: r.json.sha };
}

// ---- 加密原语（与 v1-v8-verify.mjs 相同参数）
async function kekFromPassword(password, salt) {
  const base = await subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: P.KDF_PASSWORD_ITERATIONS, hash: 'SHA-256' },
    base, { name: P.CIPHER, length: P.KEK_BYTES * 8 }, false, ['wrapKey', 'unwrapKey'],
  );
}
async function kekFromRecovery(code, salt) {
  const base = await subtle.importKey('raw', utf8(normRecovery(code)), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: utf8(P.KDF_RECOVERY_INFO) },
    base, { name: P.CIPHER, length: P.KEK_BYTES * 8 }, false, ['wrapKey', 'unwrapKey'],
  );
}
async function wrapDek(kek, dek) {
  const iv = randomBytes(P.WRAP_IV_BYTES);
  const wrapped = await subtle.wrapKey('raw', dek, kek, { name: P.CIPHER, iv, tagLength: P.GCM_TAG_BITS });
  return { iv_b64: b64(iv), wrapped_dek_b64: b64(wrapped) };
}
async function unwrapDek(kek, wrap) {
  return subtle.unwrapKey(
    'raw', unb64(wrap.wrapped_dek_b64), kek,
    { name: P.CIPHER, iv: unb64(wrap.iv_b64), tagLength: P.GCM_TAG_BITS },
    { name: P.CIPHER, length: P.DEK_BYTES * 8 }, false, ['encrypt', 'decrypt'],
  );
}
const aadFor = (v, m, id) => utf8(`${P.AAD_PREFIX}|${v}|${m}|${id}`);
async function encryptSnapshot(dek, obj) {
  const iv = randomBytes(P.IV_BYTES);
  const ct = await subtle.encrypt(
    { name: P.CIPHER, iv, tagLength: P.GCM_TAG_BITS, additionalData: aadFor(P.FORMAT_VERSION, MACHINE, SNAPSHOT_ID) },
    dek, utf8(JSON.stringify(obj)),
  );
  return b64(Buffer.concat([iv, Buffer.from(ct)]));
}
async function decryptSnapshot(dek, encText) {
  const raw = Buffer.from(encText.trim(), 'base64');
  const pt = await subtle.decrypt(
    { name: P.CIPHER, iv: raw.subarray(0, P.IV_BYTES), tagLength: P.GCM_TAG_BITS, additionalData: aadFor(P.FORMAT_VERSION, MACHINE, SNAPSHOT_ID) },
    dek, raw.subarray(P.IV_BYTES),
  );
  return JSON.parse(dec(new Uint8Array(pt)));
}

// ---- 断言
const results = [];
function check(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} · ${title}${ok ? '' : `\n        ${detail}`}`);
}

/** 构造有足够辨识度的样本数据 */
function samplePayload() {
  const mk = (i) => ({ title: `书签 ${i} · 中文/符号 <>&"${i}`, url: `https://example.com/path/${i}?q=${i}#frag`, dateAdded: 1739000000000 + i });
  return {
    bookmarks: {
      children: [
        { title: '书签栏', children: Array.from({ length: 120 }, (_, i) => mk(i)) },
        { title: '其他书签', children: [{ title: '嵌套/目录', children: [mk(999)] }] },
      ],
    },
    settings: { homepageOverride: 'https://example.com/', imageAnimation: 2 },
    settings_unavailable: ['browserSettings.javascriptEnabled'],
    settings_platform_note: 'firefox',
  };
}

async function main() {
  const keepRepo = process.argv.includes('--keep-repo');
  console.log('='.repeat(70));
  console.log('真实端到端测试（Gitee 私有仓库）');
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`令牌: ${TOKEN ? '已提供' : '未提供'}`);
  console.log('='.repeat(70));

  if (!TOKEN) { console.log('\n缺少 GITEE_TOKEN'); process.exitCode = 2; return; }

  const me = await req('GET', '/user');
  if (me.http !== 200) { console.log(`\n令牌无效: http=${me.http}`); process.exitCode = 2; return; }
  const login = me.json.login;
  const repo = `${login}/${REPO_NAME}`;
  console.log(`\n临时仓库: ${repo}`);

  // 清理可能残留的同名仓库
  const pre = await req('GET', `/repos/${repo}`);
  if (pre.http === 200) {
    console.log('  同名仓库已存在，先删除');
    const d = await req('DELETE', `/repos/${repo}`);
    if (d.http >= 400) { console.log(`  删除失败: ${d.body.slice(0, 160)}`); process.exitCode = 1; return; }
  }
  const created = await req('POST', '/user/repos', {
    body: { access_token: TOKEN, name: REPO_NAME, private: true, auto_init: false, description: 'upbookmarks E2E 临时仓库' },
  });
  if (created.http !== 201 && created.http !== 200) {
    console.log(`  建仓失败: ${created.http} ${created.body.slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  建仓成功: private=${created.json?.private}`);

  const PASSWORD = '端到端-测试-口令-短语-六个词-以上';
  const RECOVERY = genRecovery();
  const payload = samplePayload();
  const payloadJson = JSON.stringify(payload);
  const payloadHash = sha256(payloadJson);

  try {
    // ======================================================= 设备 A：上传
    console.log('\n—— 设备 A：生成密钥并上传 ——');
    const dek = await subtle.generateKey({ name: P.CIPHER, length: P.DEK_BYTES * 8 }, true, ['encrypt', 'decrypt']);
    const pwdSalt = randomBytes(P.KDF_PASSWORD_SALT_BYTES);
    const recSalt = randomBytes(P.KDF_RECOVERY_SALT_BYTES);
    const wPwd = await wrapDek(await kekFromPassword(PASSWORD, pwdSalt), dek);
    const wRec = await wrapDek(await kekFromRecovery(RECOVERY, recSalt), dek);
    const keyfile = {
      format: P.KEYFILE_FORMAT,
      format_version: P.FORMAT_VERSION,
      created_at: new Date().toISOString(),
      wraps: [
        { method: 'password', kdf: { algo: P.KDF_PASSWORD_ALGO, iterations: P.KDF_PASSWORD_ITERATIONS, salt_b64: b64(pwdSalt) }, ...wPwd },
        { method: 'recovery', kdf: { algo: P.KDF_RECOVERY_ALGO, salt_b64: b64(recSalt) }, ...wRec },
      ],
    };
    const enc = await encryptSnapshot(dek, payload);
    console.log(`  明文 ${payloadJson.length} 字节 → 密文 ${enc.length} 字节`);

    const upKeyfile = await putFile(repo, KEYFILE_PATH, JSON.stringify(keyfile, null, 2), 'e2e: keyfile');
    check('E-1', '上传 keyfile.json 到 Gitee', upKeyfile.http === 201 || upKeyfile.http === 200, `http=${upKeyfile.http} ${upKeyfile.body.slice(0, 120)}`);

    // 注意：enc 本身已是 base64 文本，必须按「原样字节」落盘，不能再编码一次
    const upSnap = await putFile(repo, SNAPSHOT_PATH, enc, 'e2e: snapshot');
    check('E-2', '上传加密快照到 Gitee', upSnap.http === 201 || upSnap.http === 200, `http=${upSnap.http} ${upSnap.body.slice(0, 120)}`);

    // 立即读回，确认落盘的确实是「原样的 base64 文本」而不是被二次编码
    const snapReadback = await readFile(repo, SNAPSHOT_PATH);
    check('E-2b', '快照落盘内容与原文逐字符一致（未被二次编码）',
      snapReadback.text?.trim() === enc.trim(),
      `读回 ${snapReadback.text?.length} 字符 vs 原文 ${enc.length} 字符`);

    // index.json
    const indexObj = {
      format: P.INDEX_FORMAT, format_version: P.FORMAT_VERSION, machine: MACHINE,
      snapshots: [{ id: SNAPSHOT_ID, file: `${SNAPSHOT_ID}.enc`, created_at: '2026-02-14T10:30:00Z', bytes: enc.length, sha: upSnap.json?.content?.sha ?? null }],
    };
    const upIndex = await putFile(repo, `${BACKUPS_DIR}/${MACHINE}/index.json`, JSON.stringify(indexObj, null, 2), 'e2e: index');
    check('E-3', '上传 index.json 到 Gitee', upIndex.http === 201 || upIndex.http === 200, `http=${upIndex.http}`);

    // 私有性：匿名读应为 404
    const anon = await fetch(`${API_BASE}/repos/${repo}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    check('E-4', '仓库对匿名不可见（无令牌读 → 404）', anon.status === 404, `匿名 http=${anon.status}（期望 404）`);

    // ======================================================= 设备 B：只用密码还原
    console.log('\n—— 设备 B：全新环境，只有密码 ——');
    const bDir = await mkdtemp(join(tmpdir(), 'upbookmarks-e2e-B-'));
    await writeFile(join(bDir, 'README.txt'), '此目录模拟全新设备，不含任何密钥状态', 'utf8');

    const kfB = await readFile(repo, KEYFILE_PATH);
    const snapB = await readFile(repo, SNAPSHOT_PATH);
    check('E-5', '设备 B 从 Gitee 取回 keyfile 与快照',
      !!kfB.text && !!snapB.text, `keyfile=${kfB.text?.length}字节 snapshot=${snapB.text?.length}字节`);

    const kfBObj = JSON.parse(kfB.text);
    const wPwdB = kfBObj.wraps.find((w) => w.method === 'password');
    const dekB = await unwrapDek(await kekFromPassword(PASSWORD, unb64(wPwdB.kdf.salt_b64)), wPwdB);
    const restoredB = await decryptSnapshot(dekB, snapB.text);
    const restoredBJson = JSON.stringify(restoredB);
    check('E-6', '设备 B 仅凭密码解密还原成功',
      restoredBJson === payloadJson,
      `还原哈希 ${sha256(restoredBJson).slice(0, 16)} vs 原始 ${payloadHash.slice(0, 16)}`);
    await rm(bDir, { recursive: true, force: true });

    // ======================================================= 设备 C：只用恢复码还原
    console.log('\n—— 设备 C：全新环境，只有恢复码 ——');
    const cDir = await mkdtemp(join(tmpdir(), 'upbookmarks-e2e-C-'));
    await writeFile(join(cDir, 'README.txt'), '此目录模拟全新设备，只有恢复码', 'utf8');

    const wRecC = kfBObj.wraps.find((w) => w.method === 'recovery');
    const dekC = await unwrapDek(await kekFromRecovery(RECOVERY, unb64(wRecC.kdf.salt_b64)), wRecC);
    const restoredC = await decryptSnapshot(dekC, snapB.text);
    const restoredCJson = JSON.stringify(restoredC);
    check('E-7', '设备 C 仅凭恢复码解密还原成功',
      restoredCJson === payloadJson,
      `还原哈希 ${sha256(restoredCJson).slice(0, 16)}`);
    await rm(cDir, { recursive: true, force: true });

    // ======================================================= 存取一致性
    const kfBack = JSON.parse((await readFile(repo, KEYFILE_PATH)).text);
    check('E-8', 'keyfile 经 Gitee 往返后结构不变',
      JSON.stringify(kfBack) === JSON.stringify(kfBObj),
      '结构发生变化');

    const idxBack = JSON.parse((await readFile(repo, `${BACKUPS_DIR}/${MACHINE}/index.json`)).text);
    check('E-9', 'index.json 经 Gitee 往返后结构不变',
      JSON.stringify(idxBack) === JSON.stringify(indexObj),
      '结构发生变化');

    const snapBack = await readFile(repo, SNAPSHOT_PATH);
    check('E-10', '快照密文经 Gitee 往返后逐字节一致',
      snapBack.text.trim() === enc.trim(),
      `长度 ${snapBack.text?.length} vs ${enc.length}`);

    // 列目录，确认路径与机器目录结构正确
    const listRoot = await req('GET', contentsPath(repo));
    const rootNames = Array.isArray(listRoot.json) ? listRoot.json.map((e) => e.name).sort() : [];
    const listMachine = await req('GET', contentsPath(repo, `${BACKUPS_DIR}/${MACHINE}`));
    const machineNames = Array.isArray(listMachine.json) ? listMachine.json.map((e) => e.name).sort() : [];
    check('E-11', `仓库目录结构符合设计（根含 keyfile 与 ${BACKUPS_DIR}/${MACHINE}）`,
      rootNames.includes('keyfile.json') && rootNames.includes(BACKUPS_DIR) && machineNames.includes('index.json'),
      `根=[${rootNames}] ${MACHINE}=[${machineNames}]`);

    // 不存在的路径应为 200 + []
    const missing = await req('GET', contentsPath(repo, `${BACKUPS_DIR}/${MACHINE}/nope.enc`));
    check('E-12', '不存在的快照返回 200 + []（设计的判据）',
      missing.http === 200 && Array.isArray(missing.json) && missing.json.length === 0,
      `http=${missing.http} body=${missing.body.slice(0, 60)}`);
  } finally {
    console.log('\n—— 清理 ——');
    if (keepRepo) {
      console.log(`  按 --keep-repo 保留仓库: ${repo}`);
    } else {
      const del = await req('DELETE', `/repos/${repo}`);
      console.log(`  删除临时仓库: http=${del.http}`);
      if (del.http >= 400) console.log(`  ⚠ 请手动删除 ${repo}: ${del.body.slice(0, 160)}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(70));
  console.log(`小结: PASS=${results.length - failed.length}  FAIL=${failed.length}`);
  console.log('='.repeat(70));

  const reportPath = join(dirname(fileURLToPath(import.meta.url)), 'out', 'e2e-report.json');
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({
    ranAt: new Date().toISOString(), repo, payloadHash, payloadBytes: payloadJson.length,
    summary: { pass: results.length - failed.length, fail: failed.length }, results,
  }, null, 2), 'utf8');
  console.log(`报告已写入: ${reportPath}`);

  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error('E2E 异常终止:', e); process.exitCode = 2; });
