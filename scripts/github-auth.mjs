import { spawnSync } from 'node:child_process';
import { githubApi, localToken, REPO } from '../lib/github.mjs';

const token = localToken();
const user = await githubApi('/user', { token });
if (user.login.toLowerCase() !== 'dewyingyi1') throw new Error('登录账号与仓库所有者不符，未配置或上传。');
const repo = await githubApi(`/repos/${REPO}`, { token });
if (!repo.permissions?.push) throw new Error('当前授权无仓库写入权限。');
const name = user.login;
const email = `${user.id}+${user.login}@users.noreply.github.com`;
for (const [key, value] of [['user.name', name], ['user.email', email]]) {
  const result = spawnSync('git', ['config', '--local', key, value], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('本仓库提交身份配置失败');
}
console.log(`已确认账号 ${user.login} 有仓库写入权限；本项目使用 GitHub 隐私邮箱提交，不改全局配置。`);
