import { spawnSync } from 'node:child_process';

export const REPO = 'DewYingyi1/hoyo-cn-calendar';
export function localToken() {
  const result = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\nusername=DewYingyi1\n\n', encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, timeout: 15000,
  });
  if (result.status !== 0) throw new Error('本机 GitHub 授权尚未完成。请在官方浏览器页面授权 Git Credential Manager。');
  const token = /^password=(.+)$/m.exec(result.stdout)?.[1]?.trim();
  if (!token) throw new Error('凭据管理器未返回有效授权。');
  // Never print, write or commit the credential. It stays in the credential manager.
  return token;
}
export async function githubApi(route, { token, method = 'GET', body } = {}) {
  const response = await fetch(`https://api.github.com${route}`, {
    method,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token ?? process.env.GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'hoyo-cn-calendar' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${route}：HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
