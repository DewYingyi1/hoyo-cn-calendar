import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function evaluateStatus(status) {
  const gameCount = Object.keys(status?.games ?? {}).length;
  const problems = [];
  const warnings = [];
  if (!gameCount) problems.push('没有配置游戏状态');
  if ((status?.successfulSources ?? 0) !== gameCount) problems.push(`来源成功 ${status?.successfulSources ?? 0}/${gameCount}`);
  if ((status?.completeSources ?? 0) !== gameCount) warnings.push(`完整来源 ${status?.completeSources ?? 0}/${gameCount}`);
  if ((status?.partialSources ?? 0) !== 0) warnings.push(`部分来源 ${status.partialSources}`);
  if ((status?.reviewCount ?? 0) !== 0) warnings.push(`待复核 ${status.reviewCount}`);
  if ((status?.issues ?? []).length !== 0) warnings.push(`告警 ${status.issues.length}`);
  for (const [game, value] of Object.entries(status?.games ?? {})) {
    if (value.error && /source-(?:http|format|size|response|timeout|fetch|invalid|processing)/.test(value.error)) problems.push(`${game}：${value.error}`);
    else if (value.error) warnings.push(`${game}：${value.error}`);
    if (value.partial) warnings.push(`${game}：partial=true`);
  }
  return { ok: problems.length === 0, gameCount, problems, warnings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const file = process.argv[2] ?? 'data/status.json';
  const status = JSON.parse(await fs.readFile(file, 'utf8'));
  const result = evaluateStatus(status);
  console.log(JSON.stringify({ file, generatedAt: status.generatedAt, lastAttemptAt: status.lastAttemptAt, ...result }));
  if (process.env.GITHUB_ACTIONS === 'true' && result.warnings.length) {
    console.log(`::warning::Calendar published with ${result.warnings.length} health warnings; inspect status.json and maintenance Issue.`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## Calendar publication health\n\n- Source fetch health: ${result.ok ? 'PASS' : 'FAIL'}\n- Warnings: ${result.warnings.length}\n- Pending reviews: ${status.reviewCount ?? 0}\n- Complete sources: ${status.completeSources ?? 0}/${result.gameCount}\n\nSee status.json and the maintenance Issue for details.\n`);
  }
  if (!result.ok) process.exitCode = 1;
}
