#!/usr/bin/env node
/**
 * WebCrypto 跨平台一致性 —— Node 侧参考值
 *
 * 与 tools/crypto-consistency/harness.html 使用**完全相同的固定输入**，
 * 产出同一组键值。两者逐行相同，才说明「脚本里验证过的加密参数在浏览器里同样成立」。
 *
 * 用法：
 *   node tools/crypto-consistency/reference-node.mjs
 *   node tools/crypto-consistency/compare.mjs            # 自动跑 Firefox 并对比
 */

import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

export const P = {
  CIPHER: 'AES-GCM',
  DEK_BYTES: 32,
  KEK_BYTES: 32,
  GCM_TAG_BITS: 128,
  AAD_PREFIX: 'upbookmarks',
  KDF_PASSWORD_ITERATIONS: 600000,
  KDF_PASSWORD_SALT_BYTES: 16,
  KDF_RECOVERY_INFO: 'upbookmarks/recovery-key/v1',
  KDF_RECOVERY_SALT_BYTES: 16,
  FORMAT_VERSION: 1,
};

export const PASSWORD = '端到端-测试-口令-短语-六个词-以上';
export const RECOVERY_CODE = 'ABCDE-FGHJK-MNPQR-STVWX-YZ234-56789-ABCDE-FGHJK';
export const AAD_MACHINE = 'desktop';
export const AAD_SNAPSHOT_ID = '20260214T103000Z';
export const FIXED_IV = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
export const FIXED_WRAP_IV = new Uint8Array([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);

const utf8 = (s) => new TextEncoder().encode(s);
const toHex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
const toB64 = (b) => Buffer.from(b).toString('base64');
const normRecovery = (c) => c.replace(/[^0-9A-Za-z]/g, '').toUpperCase();

const sha256Hex = async (s) => toHex(await subtle.digest('SHA-256', utf8(s)));
const passwordSalt = async () => new Uint8Array(await subtle.digest('SHA-256', utf8('upbookmarks/test/salt/password'))).slice(0, P.KDF_PASSWORD_SALT_BYTES);
const recoverySalt = async () => new Uint8Array(await subtle.digest('SHA-256', utf8('upbookmarks/test/salt/recovery'))).slice(0, P.KDF_RECOVERY_SALT_BYTES);

async function kekFromPassword(password, salt) {
  const base = await subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: P.KDF_PASSWORD_ITERATIONS, hash: 'SHA-256' },
    base, { name: P.CIPHER, length: P.KEK_BYTES * 8 }, true, ['wrapKey', 'unwrapKey']);
}
async function kekFromRecovery(code, salt) {
  const base = await subtle.importKey('raw', utf8(normRecovery(code)), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: utf8(P.KDF_RECOVERY_INFO) },
    base, { name: P.CIPHER, length: P.KEK_BYTES * 8 }, true, ['wrapKey', 'unwrapKey']);
}
const aad = () => utf8(`${P.AAD_PREFIX}|${P.FORMAT_VERSION}|${AAD_MACHINE}|${AAD_SNAPSHOT_ID}`);

export async function computeReference() {
  const out = [];
  const rec = (k, v) => out.push(`${k}=${v}`);

  const pwdKek = await kekFromPassword(PASSWORD, await passwordSalt());
  rec('C1.passwordKekHex', toHex(await subtle.exportKey('raw', pwdKek)));

  const recKek = await kekFromRecovery(RECOVERY_CODE, await recoverySalt());
  rec('C2.recoveryKekHex', toHex(await subtle.exportKey('raw', recKek)));

  const dekRaw = await subtle.digest('SHA-256', utf8('upbookmarks/test/dek/seed'));
  rec('C3.dekHex', toHex(dekRaw));
  const dek = await subtle.importKey('raw', new Uint8Array(dekRaw), P.CIPHER, true, ['encrypt', 'decrypt']);
  const wrapped = await subtle.wrapKey('raw', dek, pwdKek, { name: P.CIPHER, iv: FIXED_WRAP_IV, tagLength: P.GCM_TAG_BITS });
  rec('C3.wrappedDekHex', toHex(wrapped));

  const unwrapped = await subtle.unwrapKey(
    'raw', wrapped, pwdKek, { name: P.CIPHER, iv: FIXED_WRAP_IV, tagLength: P.GCM_TAG_BITS },
    { name: P.CIPHER, length: P.DEK_BYTES * 8 }, true, ['encrypt', 'decrypt']);
  rec('C4.unwrappedDekHex', toHex(await subtle.exportKey('raw', unwrapped)));

  const plaintext = JSON.stringify({ bookmarks: { children: [{ title: '书签栏', children: [{ title: '示例 · 中文', url: 'https://example.com/', dateAdded: 1739000000000 }] }] }, settings: { homepageOverride: 'https://example.com/' } });
  rec('C5.plaintextSha256', await sha256Hex(plaintext));
  const ct = await subtle.encrypt(
    { name: P.CIPHER, iv: FIXED_IV, tagLength: P.GCM_TAG_BITS, additionalData: aad() }, dek, utf8(plaintext));
  rec('C5.ciphertextB64', toB64(ct));

  const pt = await subtle.decrypt(
    { name: P.CIPHER, iv: FIXED_IV, tagLength: P.GCM_TAG_BITS, additionalData: aad() }, dek, ct);
  rec('C6.decryptedSha256', await sha256Hex(new TextDecoder().decode(pt)));
  rec('C6.roundTripOk', String(new TextDecoder().decode(pt) === plaintext));

  try {
    await subtle.decrypt(
      { name: P.CIPHER, iv: FIXED_IV, tagLength: P.GCM_TAG_BITS, additionalData: utf8('upbookmarks|1|laptop|20260214T103000Z') },
      dek, ct);
    rec('C7.aadMismatchRejected', 'false');
  } catch {
    rec('C7.aadMismatchRejected', 'true');
  }

  rec('C8.hasWrapKey', String(typeof subtle.wrapKey === 'function'));
  rec('C8.runtime', `node ${process.version}`);
  rec('C9.done', 'true');
  return out;
}

// 直接运行时打印参考值
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('reference-node.mjs')) {
  const lines = await computeReference();
  console.log(lines.join('\n'));
}
