/**
 * 工具栏弹窗 —— 只显示状态并提供入口
 *
 * 刻意不在这里放上传/还原：弹窗在失焦时会关闭，而上传（PBKDF2 解锁 + 网络）
 * 需要用户在场且不能被打断。那些操作都在选项页里做。
 */

import { getApi, describeCapabilities, configStore } from '../lib/platform.js';

const api = getApi();
const statusEl = document.getElementById('status');
const capsEl = document.getElementById('caps');

document.getElementById('open-options').addEventListener('click', () => {
  if (api?.runtime?.openOptionsPage) api.runtime.openOptionsPage();
  window.close();
});

async function main() {
  if (!api) {
    statusEl.textContent = '不在扩展环境里。';
    statusEl.className = 'err';
    return;
  }

  const caps = describeCapabilities(api);
  if (caps.note) {
    capsEl.hidden = false;
    capsEl.textContent = caps.note;
  }

  try {
    const cfg = await configStore(api).read();
    const configured = Boolean(cfg.gitee_owner && cfg.gitee_repo && cfg.pat);
    statusEl.textContent = configured
      ? `仓库：${cfg.gitee_owner}/${cfg.gitee_repo}　本机：${cfg.machine_name ?? '未设置'}`
      : '尚未配置仓库。打开设置页填写。';
    statusEl.className = configured ? '' : 'muted';
  } catch (e) {
    statusEl.textContent = `读取配置失败：${e.message}`;
    statusEl.className = 'err';
  }
}

main();
