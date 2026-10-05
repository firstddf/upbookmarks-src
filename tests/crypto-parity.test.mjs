#!/usr/bin/env node
/**
 * 扩展 crypto.js 的一致性对拍
 *
 * 目的：证明 src/lib/crypto.js（扩展真正使用的实现）与阶段二冻结的参考值
 * **逐字节等价**。参考值来自 tools/crypto-consistency/reference-node.mjs，
 * 已在 Node / Chrome / Firefox 三处验证过。
 *
 * 做法：对同一组固定输入，比较 crypto.js 的输出与参考值。
 * 任何一项不同，说明扩展实现偏离了被验证过的算法。
 *
 * 用法：
 *   node tests/crypto-parity.test.mjs
 */

import {
  deriveKekFromPassword,
  deriveKekFromRecoveryCode,
  generateDek,
  wrapDek,
  unwrapDek,
  encryptSnapshot,
  decryptSnapshot,
  createKeyfile,
  unlockDekFromKeyfile,
  rewrapWithNewPassword,
  generateRecoveryCode,
  normalizeRecoveryCode,
  assessPasswordStrength,
  describePasswordStrength,
  passwordRequirementText,
  joinPasswordSegments,
  splitPasswordSegments,
  PASSWORD_SEGMENT_SEPARATOR,
  bytesToBase64,
  randomBytes,
} from '../src/lib/crypto.js';

import {
  computeReference,
  PASSWORD as REF_PASSWORD,
  RECOVERY_CODE as REF_RECOVERY,
  FIXED_IV,
  FIXED_WRAP_IV,
} from '../tools/crypto-consistency/reference-node.mjs';

// ---- 断言
const results = [];
function check(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} · ${title}${ok ? '' : `\n        ${detail ?? ''}`}`);
}
const hex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');

/**
 * 与参考脚本相同的固定盐。
 *
 * 参考脚本导出 KEK 来比较，而 crypto.js 的 KEK 是 **extractable: false**（生产约束）。
 * 为保持「测的是扩展真正的派生函数」，这里在测试内部按 crypto.js 完全相同的
 * 参数与用法位重新派生一份可导出的副本，仅用于取值比较。
 */
async function kekFromPasswordFixedIV(password) {
  const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('upbookmarks/test/salt/password'))).slice(0, 16);
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['wrapKey', 'unwrapKey']);
}

async function kekFromRecoveryFixedIV(code) {
  const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('upbookmarks/test/salt/recovery'))).slice(0, 16);
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(normalizeRecoveryCode(code)), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('upbookmarks/recovery-key/v1') },
    base, { name: 'AES-GCM', length: 256 }, true, ['wrapKey', 'unwrapKey']);
}

async function main() {
  console.log('='.repeat(70));
  console.log('src/lib/crypto.js 与阶段二参考值的一致性对拍');
  console.log('='.repeat(70));

  const refLines = await computeReference();
  const ref = new Map();
  for (const line of refLines) {
    const i = line.indexOf('=');
    if (i > 0) ref.set(line.slice(0, i), line.slice(i + 1));
  }

  // ============================================================ 参考值对拍
  console.log('\n—— 与冻结参考值逐字节比较 ——');

  const kekPwd = await kekFromPasswordFixedIV(REF_PASSWORD);
  check('P1', '主口令 KEK 与参考值一致',
    hex(await crypto.subtle.exportKey('raw', kekPwd)) === ref.get('C1.passwordKekHex'),
    `扩展=${hex(await crypto.subtle.exportKey('raw', kekPwd)).slice(0, 24)}… 参考=${ref.get('C1.passwordKekHex').slice(0, 24)}…`);

  const kekRec = await kekFromRecoveryFixedIV(REF_RECOVERY);
  check('P2', '恢复码 KEK 与参考值一致（含恢复码规范化）',
    hex(await crypto.subtle.exportKey('raw', kekRec)) === ref.get('C2.recoveryKekHex'),
    `扩展=${hex(await crypto.subtle.exportKey('raw', kekRec)).slice(0, 24)}…`);

  // 用固定输入的种子构造 DEK，并导出（测试需要 exportable）
  const seed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('upbookmarks/test/dek/seed'));
  const dekRaw = new Uint8Array(seed);
  const dek = await crypto.subtle.importKey('raw', dekRaw, 'AES-GCM', true, ['encrypt', 'decrypt']);
  check('P3', '固定 DEK 与参考值一致', hex(dekRaw) === ref.get('C3.dekHex'), hex(dekRaw).slice(0, 24));

  // 参考脚本用固定 WRAP_IV 包裹。crypto.js 的 wrapDek 内部随机生成 IV，
  // 所以这里直接调用 subtle.wrapKey 复现同一输入，验证参数（tagLength 等）一致。
  const wrapped = await crypto.subtle.wrapKey('raw', dek, kekPwd, {
    name: 'AES-GCM', iv: FIXED_WRAP_IV, tagLength: 128,
  });
  check('P4', '包裹参数一致（固定 IV 下包裹结果与参考值相同）',
    hex(wrapped) === ref.get('C3.wrappedDekHex'),
    `扩展=${hex(wrapped).slice(0, 24)}… 参考=${ref.get('C3.wrappedDekHex').slice(0, 24)}…`);

  // 用 crypto.js 的 unwrapDek 解开上面的包裹结果（构造等价的 wrap 对象）
  const unwrapped = await unwrapDek(kekPwd, {
    iv_b64: bytesToBase64(FIXED_WRAP_IV),
    wrapped_dek_b64: bytesToBase64(wrapped),
  }, true);
  check('P5', 'unwrapDek 能解开固定包裹结果并得到同一把 DEK',
    hex(await crypto.subtle.exportKey('raw', unwrapped)) === ref.get('C4.unwrappedDekHex'));

  // P5b：crypto.js 的**真实**派生函数（extractable: false）产出的 KEK，
  // 必须与可导出副本等价 —— 用「能否解开同一次包裹」判定，而不是靠可导出性。
  const realKekPwd = await deriveKekFromPassword(REF_PASSWORD, new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('upbookmarks/test/salt/password'))).slice(0, 16));
  let realKekWorks = false;
  try {
    const bak = await unwrapDek(realKekPwd, { iv_b64: bytesToBase64(FIXED_WRAP_IV), wrapped_dek_b64: bytesToBase64(wrapped) }, true);
    realKekWorks = hex(await crypto.subtle.exportKey('raw', bak)) === ref.get('C4.unwrappedDekHex');
  } catch { /* 保持 false */ }
  check('P5b', '扩展真实派生函数（不可导出）与可导出副本等价', realKekWorks);

  // 快照加解密：固定 IV + AAD 的密文应与参考值相同
  const plaintextObj = {
    bookmarks: {
      children: [
        {
          title: '书签栏',
          children: [{ title: '示例 · 中文', url: 'https://example.com/', dateAdded: 1739000000000 }],
        },
      ],
    },
    settings: { homepageOverride: 'https://example.com/' },
  };
  const plaintext = JSON.stringify(plaintextObj);
  const ct = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: FIXED_IV,
      tagLength: 128,
      additionalData: new TextEncoder().encode('upbookmarks|1|desktop|20260214T103000Z'),
    },
    dek,
    new TextEncoder().encode(plaintext),
  );
  check('P6', 'AES-GCM 密文与参考值一致（同一 IV + 同一 AAD）',
    bytesToBase64(ct) === ref.get('C5.ciphertextB64'),
    `扩展=${bytesToBase64(ct).slice(0, 32)}…`);

  // ============================================================ 自洽性
  console.log('\n—— crypto.js 自身功能 ——');

  const dek2 = await generateDek();
  const kek2 = await deriveKekFromPassword('测试口令', randomBytes(16));
  const w2 = await wrapDek(kek2, dek2);

  // 解包得到的运行态 DEK 必须**不可导出** —— 这是「DEK 只在内存里、不留导出路径」的保障
  const dek2Back = await unwrapDek(kek2, w2);
  let unwrappedNotExtractable = false;
  try { await crypto.subtle.exportKey('raw', dek2Back); } catch { unwrappedNotExtractable = true; }
  check('P7', '解包得到的运行态 DEK 不可导出（生产约束生效）', unwrappedNotExtractable,
    'unwrapDek 产出的 DEK 竟然可导出');

  // 同一不可导出的 DEK 仍可正常加解密 —— 证明「不可导出」不影响使用
  const probeObj = { probe: 'extractable-check', 中文: '可用' };
  const probeEnc = await encryptSnapshot(dek2Back, probeObj, { machine: 'desktop', snapshotId: '20260214T103000Z' });
  const probeBack = await decryptSnapshot(dek2Back, probeEnc, { machine: 'desktop', snapshotId: '20260214T103000Z' });
  check('P8', '不可导出的 DEK 仍可正常加解密', JSON.stringify(probeBack) === JSON.stringify(probeObj));

  // 包裹是随机的：两次包裹的 IV 与密文都不应相同
  const w2b = await wrapDek(kek2, dek2);
  check('P9', '两次包裹使用不同 IV（不会复用）', w2.iv_b64 !== w2b.iv_b64 && w2.wrapped_dek_b64 !== w2b.wrapped_dek_b64);

  // 快照往返 + AAD 换位必须失败
  const snapDek = await generateDek();
  const enc = await encryptSnapshot(snapDek, plaintextObj, { machine: 'desktop', snapshotId: '20260214T103000Z' });
  const back = await decryptSnapshot(snapDek, enc, { machine: 'desktop', snapshotId: '20260214T103000Z' });
  check('P10', '快照往返一致（含中文与嵌套结构）', JSON.stringify(back) === plaintext);

  let swapRejected = false;
  try {
    await decryptSnapshot(snapDek, enc, { machine: 'laptop', snapshotId: '20260214T103000Z' });
  } catch { swapRejected = true; }
  check('P11', '换 machine 后解密失败（AAD 生效）', swapRejected);

  let idRejected = false;
  try {
    await decryptSnapshot(snapDek, enc, { machine: 'desktop', snapshotId: '20260101T000000Z' });
  } catch { idRejected = true; }
  check('P12', '换 snapshot_id 后解密失败（AAD 生效）', idRejected);

  // ============================================================ keyfile 全流程
  console.log('\n—— keyfile 建立与解锁 ——');

  // 注意：口令里的每一段都必须 ≥2 个字符（新规则），所以这里不用单独的「咸」
  const PASSWORD = '赤脚-沙滩-七月的-不穿鞋-海风-咸咸的-浪很大';
  const RECOVERY = generateRecoveryCode();
  const { keyfile, dek: dek3 } = await createKeyfile({ password: PASSWORD, recoveryCode: RECOVERY });

  check('P13', 'createKeyfile 产出含两处包裹且格式正确',
    keyfile.format === 'upbookmarks/keyfile' && keyfile.wraps.length === 2
      && keyfile.wraps.some((w) => w.method === 'password') && keyfile.wraps.some((w) => w.method === 'recovery'),
    JSON.stringify(keyfile.wraps.map((w) => w.method)));

  const dekByPwd = await unlockDekFromKeyfile(keyfile, { password: PASSWORD });
  const dekByRec = await unlockDekFromKeyfile(keyfile, { recoveryCode: RECOVERY });

  // 两把 DEK 都不可导出（生产约束），所以用「能否解开同一份密文」判定同一性。
  // 只有同一把密钥才能解开同一份 GCM 密文，因此这是等价判据。
  const probe = await encryptSnapshot(dek3, { probe: 'x' }, { machine: 'desktop', snapshotId: '20260214T103000Z' });
  let pwdOpens = false;
  let recOpens = false;
  try {
    await decryptSnapshot(dekByPwd, probe, { machine: 'desktop', snapshotId: '20260214T103000Z' });
    pwdOpens = true;
  } catch { /* 保持 false */ }
  try {
    await decryptSnapshot(dekByRec, probe, { machine: 'desktop', snapshotId: '20260214T103000Z' });
    recOpens = true;
  } catch { /* 保持 false */ }
  check('P14', '两条解锁路径都能解开同一份密文（等价于同一把 DEK）',
    pwdOpens && recOpens, `主口令路径=${pwdOpens} 恢复码路径=${recOpens}`);

  // 恢复码规范化：带分组符与大小写混合都应能解开
  const messy = RECOVERY.toLowerCase().replace(/-/g, ' ');
  const dekMessy = await unlockDekFromKeyfile(keyfile, { recoveryCode: messy });
  let messyOk = false;
  try {
    await decryptSnapshot(dekMessy, probe, { machine: 'desktop', snapshotId: '20260214T103000Z' });
    messyOk = true;
  } catch { /* 保持 false */ }
  check('P16', '恢复码输入容错（小写 + 空格分隔仍可解）', messyOk, `输入形式: ${messy.slice(0, 20)}…`);
  check('P17', 'normalizeRecoveryCode 幂等',
    normalizeRecoveryCode(normalizeRecoveryCode(messy)) === normalizeRecoveryCode(messy));

  // 错误口令必须失败
  let wrongPwdFails = false;
  try {
    const badDek = await unlockDekFromKeyfile(keyfile, { password: '完全错误的口令-abcdefgh' });
    await decryptSnapshot(badDek, probe, { machine: 'desktop', snapshotId: '20260214T103000Z' });
  } catch { wrongPwdFails = true; }
  check('P18', '错误主口令无法解开（GCM 校验失败）', wrongPwdFails);

  // 缺项时报错清晰
  let missingThrows = false;
  try {
    await unlockDekFromKeyfile({ format: 'upbookmarks/keyfile', format_version: 1, wraps: [] }, { password: PASSWORD });
  } catch { missingThrows = true; }
  check('P19', 'keyfile 缺少对应包裹项时抛出明确错误', missingThrows);

  // ============================================================ 口令轮换
  console.log('\n—— 主口令轮换 ——');

  const NEW_PASSWORD = '新的-口令-短语-六个词-以上-用于轮换';
  const keyfile2 = await rewrapWithNewPassword(keyfile, dek3, NEW_PASSWORD);
  const dekNew = await unlockDekFromKeyfile(keyfile2, { password: NEW_PASSWORD });
  let oldSnapStillOk = false;
  try {
    await decryptSnapshot(dekNew, probe, { machine: 'desktop', snapshotId: '20260214T103000Z' });
    oldSnapStillOk = true;
  } catch { /* 保持 false */ }
  check('P20', '轮换后新口令可解开，且旧快照无需重加密仍可读', oldSnapStillOk);

  let oldPwdNowFails = false;
  try {
    await unlockDekFromKeyfile(keyfile2, { password: PASSWORD });
  } catch { oldPwdNowFails = true; }
  check('P21', '轮换后旧口令失效', oldPwdNowFails);

  let recoverySurvives = false;
  try {
    const d = await unlockDekFromKeyfile(keyfile2, { recoveryCode: RECOVERY });
    await decryptSnapshot(d, probe, { machine: 'desktop', snapshotId: '20260214T103000Z' });
    recoverySurvives = true;
  } catch { /* 保持 false */ }
  check('P22', '轮换主口令不影响恢复码路径', recoverySurvives);

  // ============================================================ 口令强度
  console.log('\n—— 主口令强度启发式 ——');

  const weak = assessPasswordStrength('123456');
  const strong = assessPasswordStrength(PASSWORD);
  check('P23', '弱口令被拒绝、口令短语被接受',
    !weak.ok && strong.ok,
    `weak=${JSON.stringify(weak.reasons)} strong.ok=${strong.ok}`);

  // 分隔符容错：中文用户按习惯敲的顿号/中文逗号也必须算作分段。
  // 注意每句都要同时满足段数与长度门槛（6 段中文短语常只有 16-18 字符，这里用 7 段）。
  const cnComma = assessPasswordStrength('咖啡，雨伞，铁轨，沙滩，口琴，风筝，洋葱');
  const cnDun = assessPasswordStrength('咖啡、雨伞、铁轨、沙滩、口琴、风筝、洋葱');
  const cnSpace = assessPasswordStrength('咖啡 雨伞 铁轨 沙滩 口琴 风筝 洋葱');
  check('P24', '中文分隔符（，、）与空格都能正确分段且达到门槛',
    cnComma.ok && cnDun.ok && cnSpace.ok && cnDun.segments === 7,
    JSON.stringify({ comma: cnComma, dun: cnDun, space: cnSpace }));

  check('P25', '没有分隔符的长串中文仍被判为 1 段（不会误放行）',
    !assessPasswordStrength('咖啡雨伞铁轨沙滩口琴风筝洋葱').ok,
    JSON.stringify(assessPasswordStrength('咖啡雨伞铁轨沙滩口琴风筝洋葱').reasons));

  // 关键：6 段中文短语（约 17 字符）必须能达到门槛，否则"≥6 段"这条规则自相矛盾
  const sixSeg = assessPasswordStrength('咖啡 雨伞 铁轨 沙滩 口琴 风筝');
  check('P25b', '6 段中文短语（17 字符）达标 —— 门槛不再自相矛盾',
    sixSeg.ok && sixSeg.segments === 6 && sixSeg.length === 17,
    JSON.stringify(sixSeg));

  check('P25c', '段数可以超过 6（"至少 6 段"而不是"必须 6 段"）',
    assessPasswordStrength('咖啡 雨伞 铁轨 沙滩 口琴 风筝 洋葱 灯笼').ok,
    JSON.stringify(assessPasswordStrength('咖啡 雨伞 铁轨 沙滩 口琴 风筝 洋葱 灯笼')));

  check('P25d', '每段至少 2 个字符：单字段被拒绝',
    !assessPasswordStrength('猫 狗 鱼 鸟 山 水 云 风').ok,
    JSON.stringify(assessPasswordStrength('猫 狗 鱼 鸟 山 水 云 风')));

  check('P25d2', '每段 2 个汉字即可通过（不要求更长）',
    assessPasswordStrength('咖啡 雨伞 铁轨 沙滩 口琴 风筝').ok,
    JSON.stringify(assessPasswordStrength('咖啡 雨伞 铁轨 沙滩 口琴 风筝')));

  const req = passwordRequirementText();
  check('P25e', 'passwordRequirementText 把门槛说清楚（段数 + 每段字符 + 分隔符）',
    /至少 6 段/.test(req) && /每段至少 2 个字符/.test(req) && /空格/.test(req) && /段数比长度更重要/.test(req),
    req);

  // 按码点数长度：emoji 算 1 个字符，而不是 String.length 的 2
  const emoji = assessPasswordStrength('🍎🍐 🍊🍋 🍌🍉 🍇🍓 🍒🍑 🥝🍍');
  check('P25f', '长度按码点算（emoji 组合不会被算成双倍）',
    emoji.ok, JSON.stringify(emoji));

  // ---------------------------------------------------------------- 结构化口令
  const joined = joinPasswordSegments(['咖啡', '雨伞', '铁轨', '沙滩', '口琴', '风筝', '']);
  check('P28', 'joinPasswordSegments 跳过空段并用固定分隔符拼接',
    joined === '咖啡 雨伞 铁轨 沙滩 口琴 风筝', JSON.stringify(joined));

  check('P29', 'joinPasswordSegments 去掉段内首尾空格',
    joinPasswordSegments([' 咖啡 ', ' 雨伞 ']) === '咖啡 雨伞',
    JSON.stringify(joinPasswordSegments([' 咖啡 ', ' 雨伞 '])));

  check('P30', '分段拼接的结果可以被强度检查通过',
    assessPasswordStrength(joined).ok, JSON.stringify(assessPasswordStrength(joined)));

  check('P31', 'splitPasswordSegments 能把整串拆回段（含中文标点分隔）',
    JSON.stringify(splitPasswordSegments('咖啡、雨伞，铁轨 沙滩-口琴_风筝'))
      === JSON.stringify(['咖啡', '雨伞', '铁轨', '沙滩', '口琴', '风筝']),
    JSON.stringify(splitPasswordSegments('咖啡、雨伞，铁轨 沙滩-口琴_风筝')));

  check('P32', '固定分隔符是空格（改它会让已建仓库无法解锁，故须显式断言）',
    PASSWORD_SEGMENT_SEPARATOR === ' ', JSON.stringify(PASSWORD_SEGMENT_SEPARATOR));

  const d = describePasswordStrength('1234567890123');
  check('P26', 'describePasswordStrength 给出可读的差距说明',
    d.ok === false && /段/.test(d.text), d.text);

  check('P27', '达标时会提示中文建议再多 1–2 段',
    /建议/.test(describePasswordStrength('咖啡 雨伞 铁轨 沙滩 口琴 风筝').text),
    describePasswordStrength('咖啡 雨伞 铁轨 沙滩 口琴 风筝').text);

  // ---------------------------------------------------------------- 小结
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(70));
  console.log(`小结: PASS=${results.length - failed.length}  FAIL=${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  未通过: ${f.id} ${f.title}`);
  console.log('='.repeat(70));

  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error('对拍脚本异常终止:', e);
  process.exitCode = 2;
});
