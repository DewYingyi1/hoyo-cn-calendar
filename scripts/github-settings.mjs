import { githubApi, localToken, REPO } from '../lib/github.mjs';
const token = localToken();
const repo = await githubApi(`/repos/${REPO}`, { token });
if (repo.owner.login !== 'DewYingyi1' || !repo.permissions?.admin || repo.private) throw new Error('仓库账号、公开状态或管理权限不符');
await githubApi(`/repos/${REPO}/actions/permissions/workflow`, { token, method: 'PUT', body: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false } });
let exists = false;
try { await githubApi(`/repos/${REPO}/pages`, { token }); exists = true; }
catch (error) { if (!error.message.endsWith('HTTP 404')) throw error; }
const pages = await githubApi(`/repos/${REPO}/pages`, { token, method: exists ? 'PUT' : 'POST', body: { build_type: 'workflow' } });
console.log(`Pages 配置为 GitHub Actions 发布：${pages?.html_url ?? 'https://dewyingyi1.github.io/hoyo-cn-calendar/'}`);
