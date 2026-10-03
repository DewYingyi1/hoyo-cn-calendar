import { readJson } from './build.mjs';
import { githubApi } from '../lib/github.mjs';

if (!process.env.GITHUB_TOKEN) { console.log('本地未配置告警授权，不发送 GitHub Issue。'); process.exit(0); }
const repo = process.env.GITHUB_REPOSITORY;
if (!repo || repo !== 'DewYingyi1/hoyo-cn-calendar') throw new Error('告警只允许发到本仓库');
const status = await readJson('data/status.json', { issues: ['缺少运行状态'] });
const review = await readJson('data/review.json', []);
const pending = review.filter(item => !item.resolved);
const title = '[自动维护] 数据源与待审核公告';
const issues = await githubApi(`/repos/${repo}/issues?state=open&per_page=100`);
const issue = issues.find(item => item.title === title && !item.pull_request);
const problems = status.issues ?? [];
if (!problems.length && !pending.length) {
  if (issue) await githubApi(`/repos/${repo}/issues/${issue.number}`, { method: 'PATCH', body: { state: 'closed' } });
  console.log('无待处理告警。'); process.exit(0);
}
const body = [
  '此 Issue 自动更新，不会为每次运行重复建单。需要人工审核的公告不会被猜成日历事件。',
  '\n### 数据源问题', problems.length ? problems.map(item => `- ${item}`).join('\n') : '本轮未发现请求失败。',
  '\n### 待审核公告', ...pending.slice(0, 60).map(item => `- ${item.game}：${item.title.replace(/[\r\n]/g, ' ')}\n  ${item.url}\n  原因：${item.reason}`),
  pending.length > 60 ? `另有 ${pending.length - 60} 条，查看 data/review.json。` : '',
  '\n核对公告后修改 data/overrides.json。正常采集不能证明日程完整；本项目无独立外部停更探针。',
].filter(Boolean).join('\n');
if (issue) {
  if (issue.body !== body) await githubApi(`/repos/${repo}/issues/${issue.number}`, { method: 'PATCH', body: { body } });
} else await githubApi(`/repos/${repo}/issues`, { method: 'POST', body: { title, body } });
console.log(`告警已维护：${problems.length} 个来源问题，${pending.length} 个待审核公告。`);
