/**
 * Gitee OpenAPI v5 封装 —— 把 docs/03-parameters.md 的实测行为固化成代码
 *
 * 本模块的每条分支都对应 V9 探针实测到的一个事实，不要凭直觉改动：
 *   1. 「路径不存在」返回 **200 + `[]`**，不是 404。404 只代表仓库不存在或无权访问。
 *   2. `POST` 创建成功返回 **201**，且返回体**只含 `content` 与 `commit`**，
 *      blob sha 在 `content.sha`。
 *   3. `POST` 重复创建同名文件 → **400 `{"message":"文件名已存在"}`**。
 *   4. `PUT` 用过期 sha → **400 `{"message":"Blob SHA does not match"}`**（乐观锁）。
 *   5. 大文件直到实测最大档位（明文 6 MiB）仍内联返回 base64 `content`。
 *   6. 空仓库的 `default_branch` 为 `null` → 首次创建时**省略 `branch` 参数**。
 *
 * 本模块不依赖浏览器专有 API（用全局 fetch + AbortSignal.timeout），
 * 因此可在 Node 里用注入的假 fetch 完整测试，不需要网络或令牌。
 */

import {
  GITEE_API_BASE,
  REQUEST_TIMEOUT_MS,
  UPLOAD_RETRY,
  UPLOAD_RETRY_BACKOFF_MS,
  MAX_SNAPSHOT_BYTES,
  MAX_REQUEST_BYTES,
  base64Length,
} from './constants.js';
import { bytesToBase64, base64ToBytes } from './crypto.js';

// 扩展环境没有 Buffer，统一用 crypto.js 的字节工具（已验证与 Node 逐字节一致）
const encodeUtf8 = (s) => new TextEncoder().encode(String(s));
const decodeUtf8 = (bytes) => new TextDecoder().decode(bytes);
const decodeBase64ToText = (b64) => decodeUtf8(base64ToBytes(b64));

// ---------------------------------------------------------------- 错误分类

/**
 * 错误码。用于让上层区分「该重试」「该重新取 sha」「该报错给用户」。
 */
export const GiteeErrorCode = {
  AUTH: 'AUTH',                       // 401/403：令牌无效或权限不足
  REPO_NOT_FOUND: 'REPO_NOT_FOUND',   // 404：仓库不存在或令牌看不到它
  FILE_EXISTS: 'FILE_EXISTS',         // 400 文件名已存在
  SHA_MISMATCH: 'SHA_MISMATCH',       // 400 Blob SHA does not match
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',       // 429
  NETWORK: 'NETWORK',                 // 连接失败/超时
  HTTP: 'HTTP',                       // 其他非 2xx
};

export class GiteeError extends Error {
  constructor(code, message, { http, body, url } = {}) {
    super(message);
    this.name = 'GiteeError';
    this.code = code;
    this.http = http;
    this.body = body;
    this.url = url;
  }
}

/** 从中文错误信息里辨认具体原因（实测：Gitee 用中文 message，没有稳定错误码字段） */
function classify({ http, body, url }) {
  const text = String(body ?? '');
  if (http === 401 || http === 403) {
    return new GiteeError(GiteeErrorCode.AUTH, `令牌无效或权限不足（HTTP ${http}）`, { http, body, url });
  }
  if (http === 404) {
    return new GiteeError(
      GiteeErrorCode.REPO_NOT_FOUND,
      '仓库不存在，或当前令牌看不到它（注意：这不代表「文件不存在」）',
      { http, body, url },
    );
  }
  if (http === 429) {
    return new GiteeError(GiteeErrorCode.RATE_LIMITED, '触发 Gitee 限流', { http, body, url });
  }
  if (http === 400) {
    if (text.includes('文件名已存在')) {
      return new GiteeError(GiteeErrorCode.FILE_EXISTS, '同名文件已存在', { http, body, url });
    }
    if (/Blob SHA does not match/i.test(text)) {
      return new GiteeError(GiteeErrorCode.SHA_MISMATCH, '云端文件已被改动，本地 sha 已过期', { http, body, url });
    }
  }
  return new GiteeError(GiteeErrorCode.HTTP, `Gitee 返回 HTTP ${http}：${text.slice(0, 200)}`, { http, body, url });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRetryable = (err) =>
  err instanceof GiteeError && [GiteeErrorCode.NETWORK, GiteeErrorCode.RATE_LIMITED].includes(err.code);

// ---------------------------------------------------------------- 客户端

/**
 * 创建 Gitee 客户端。
 *
 * @param {object} opts
 * @param {string} opts.owner   仓库所有者
 * @param {string} opts.repo    仓库名
 * @param {string} opts.token   个人访问令牌（权限含 projects）
 * @param {Function} [opts.fetchImpl]  注入用，默认为全局 fetch（测试时传假实现）
 * @param {number}  [opts.timeoutMs]
 * @param {number}  [opts.retry]  仅对网络错误/限流重试，不对 4xx 重试
 */
export function createGiteeClient({
  owner,
  repo,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  retry = UPLOAD_RETRY,
  backoffMs = UPLOAD_RETRY_BACKOFF_MS,
} = {}) {
  if (!owner) throw new Error('缺少 owner');
  if (!repo) throw new Error('缺少 repo');
  if (!token) throw new Error('缺少令牌');
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl 必须是函数');

  const repoPath = `/repos/${owner}/${repo}`;
  const contentsPath = (path = '') => `${repoPath}/contents${path ? `/${path}` : ''}`;

  /** 发一次请求，不重试。返回 { http, body, json } */
  async function once(method, path, { body, query } = {}) {
    const url = new URL(GITEE_API_BASE + path);
    url.searchParams.set('access_token', token);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    const init = { method, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetchImpl(url.toString(), init);
    } catch (e) {
      throw new GiteeError(GiteeErrorCode.NETWORK, `网络请求失败：${e.message}`, { url: `${method} ${path}` });
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { http: res.status, body: text, json, url: `${method} ${path}` };
  }

  /** 带重试的请求（只重试网络错误与限流） */
  async function request(method, path, opts) {
    let lastErr;
    for (let attempt = 0; attempt <= retry; attempt++) {
      try {
        const r = await once(method, path, opts);
        if (r.http >= 200 && r.http < 300) return r;
        throw classify(r);
      } catch (e) {
        lastErr = e;
        if (!isRetryable(e) || attempt === retry) throw e;
        await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)]);
      }
    }
    throw lastErr;
  }

  const result = {
    /** 仓库信息。空仓库的 default_branch 会是 null。 */
    async getRepo() {
      const r = await request('GET', repoPath);
      return r.json;
    },

    /** 列出目录。返回数组；路径不存在时 Gitee 给的是 `[]`（不是 404）。 */
    async list(path = '') {
      const r = await request('GET', contentsPath(path));
      if (Array.isArray(r.json)) return r.json;
      // 对文件路径调用 list 会得到单个对象，视为用法错误但给出可读信息
      throw new GiteeError(GiteeErrorCode.HTTP, `路径「${path}」是一个文件，不是目录`, { http: r.http });
    },

    /** 读文件。不存在返回 null（判据：数组且长度为 0）。 */
    async read(path) {
      const r = await request('GET', contentsPath(path));
      if (Array.isArray(r.json) && r.json.length === 0) return null;
      if (Array.isArray(r.json)) {
        throw new GiteeError(GiteeErrorCode.HTTP, `路径「${path}」是目录，不是文件`, { http: r.http });
      }
      const j = r.json;
      if (!j || typeof j.sha !== 'string') {
        throw new GiteeError(GiteeErrorCode.HTTP, `读取「${path}」返回了意外结构`, { http: r.http, body: r.body });
      }
      if (typeof j.content !== 'string' || j.content.length === 0) {
        // 实测到 6 MiB 都内联返回；若走到这里，说明超过了未知门槛
        throw new GiteeError(
          GiteeErrorCode.HTTP,
          `「${path}」未内联返回内容（encoding=${j.encoding}，size=${j.size}）。` +
            `已实测到 6 MiB 仍内联，超过该门槛需要改用 download_url。`,
          { http: r.http },
        );
      }
      return { sha: j.sha, text: decodeBase64ToText(j.content), size: j.size, entry: j };
    },

    /** 读原始字节（快照是 base64 文本，按文本读即可，此方法用于将来可能的二进制文件） */
    async readText(path) {
      const f = await result.read(path);
      return f ? f.text : null;
    },

    /** 创建文件。文件已存在时抛 FILE_EXISTS。 */
    async create(path, raw, message, { branch } = {}) {
      const b64 = bytesToBase64(encodeUtf8(raw));
      if (b64.length > MAX_REQUEST_BYTES) {
        throw new GiteeError(
          GiteeErrorCode.PAYLOAD_TOO_LARGE,
          `请求体 ${b64.length} 字节超过上限 ${MAX_REQUEST_BYTES}（base64 膨胀后）`,
        );
      }
      const body = { access_token: token, content: b64, message };
      if (branch) body.branch = branch;   // 空仓库场景不要传，实测省略即可
      const r = await request('POST', contentsPath(path), { body });
      return { sha: r.json?.content?.sha ?? null, commit: r.json?.commit ?? null, entry: r.json?.content ?? null };
    },

    /** 更新文件。sha 过期时抛 SHA_MISMATCH。 */
    async update(path, raw, message, sha, { branch } = {}) {
      if (!sha) throw new Error('update 必须提供 sha');
      const b64 = bytesToBase64(encodeUtf8(raw));
      if (b64.length > MAX_REQUEST_BYTES) {
        throw new GiteeError(
          GiteeErrorCode.PAYLOAD_TOO_LARGE,
          `请求体 ${b64.length} 字节超过上限 ${MAX_REQUEST_BYTES}（base64 膨胀后）`,
        );
      }
      const body = { access_token: token, content: b64, message, sha };
      if (branch) body.branch = branch;
      const r = await request('PUT', contentsPath(path), { body });
      return { sha: r.json?.content?.sha ?? null, commit: r.json?.commit ?? null };
    },

    /** 删除文件。 */
    async remove(path, message, sha, { branch } = {}) {
      if (!sha) throw new Error('remove 必须提供 sha');
      const body = { access_token: token, message, sha };
      if (branch) body.branch = branch;
      await request('DELETE', contentsPath(path), { body });
      return true;
    },

    /**
     * 写入文件（自动选创建或更新），并把并发冲突处理好。
     *
     * 流程（对应 docs/02-design.md）：
     *   GET → 单对象则 PUT(带 sha)；`[]` 则 POST。
     *   POST 若遇 `文件名已存在`（并发下被抢先创建）→ 重新 GET 取 sha → 改用 PUT。
     *   PUT 若遇 sha 过期 → 重新 GET 取 sha → 再 PUT 一次。
     *
     * @returns {{ sha: string|null, mode: 'created'|'updated', recovered: boolean }}
     */
    async putFile(path, raw, message, { branch } = {}) {
      const existing = await result.read(path);
      if (existing) {
        try {
          const u = await result.update(path, raw, message, existing.sha, { branch });
          return { sha: u.sha, mode: 'updated', recovered: false };
        } catch (e) {
          if (!(e instanceof GiteeError) || e.code !== GiteeErrorCode.SHA_MISMATCH) throw e;
          const fresh = await result.read(path);
          if (!fresh) return result._createAfterMiss(path, raw, message, branch);
          const u2 = await result.update(path, raw, message, fresh.sha, { branch });
          return { sha: u2.sha, mode: 'updated', recovered: true };
        }
      }
      return result._createAfterMiss(path, raw, message, branch);
    },

    /** 内部：POST，遇到 FILE_EXISTS 就重新取 sha 改走 PUT */
    async _createAfterMiss(path, raw, message, branch) {
      try {
        const c = await result.create(path, raw, message, { branch });
        return { sha: c.sha, mode: 'created', recovered: false };
      } catch (e) {
        if (!(e instanceof GiteeError) || e.code !== GiteeErrorCode.FILE_EXISTS) throw e;
        // 并发下被抢先创建：重新取 sha，改用 PUT
        const fresh = await result.read(path);
        if (!fresh) throw e;   // 仍然读不到，把原始错误抛出
        const u = await result.update(path, raw, message, fresh.sha, { branch });
        return { sha: u.sha, mode: 'updated', recovered: true };
      }
    },

    /** 上传前的大小校验：载荷上限与 base64 请求体上限都要过 */
    assertSnapshotSize(payloadBytes) {
      if (payloadBytes > MAX_SNAPSHOT_BYTES) {
        throw new GiteeError(
          GiteeErrorCode.PAYLOAD_TOO_LARGE,
          `快照 ${payloadBytes} 字节超过载荷上限 ${MAX_SNAPSHOT_BYTES}`,
        );
      }
      const reqBytes = base64Length(payloadBytes);
      if (reqBytes > MAX_REQUEST_BYTES) {
        throw new GiteeError(
          GiteeErrorCode.PAYLOAD_TOO_LARGE,
          `base64 请求体 ${reqBytes} 字节超过上限 ${MAX_REQUEST_BYTES}`,
        );
      }
    },

    /** 仓库是否私有。上传前必须确认，公开则拒绝。 */
    async assertPrivate() {
      const info = await result.getRepo();
      if (info?.private !== true) {
        throw new GiteeError(
          GiteeErrorCode.HTTP,
          `仓库 ${owner}/${repo} 不是私有仓库（private=${info?.private}）。本工具拒绝上传。`,
        );
      }
      return info;
    },

    // 暴露给测试与上层
    _contentsPath: contentsPath,
    _repoPath: repoPath,
  };

  return result;
}
