import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStatus } from '../scripts/check-status.mjs';

const healthy = {
  games: { genshin: {}, starrail: {}, zzz: {} }, successfulSources: 3, completeSources: 3,
  partialSources: 0, reviewCount: 0, issues: [],
};

test('发布健康门禁接受三款完整且无待审状态', () => {
  assert.deepEqual(evaluateStatus(healthy), { ok: true, gameCount: 3, problems: [], warnings: [] });
});

test('来源失败会让健康门禁失败，人工待审作为警告保留', () => {
  const result = evaluateStatus({ ...healthy, successfulSources: 2, completeSources: 1, partialSources: 2,
    reviewCount: 1, issues: ['source failed'], games: { ...healthy.games, starrail: { error: 'source-fetch' }, zzz: { partial: true } } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ['来源成功 2/3', 'starrail：source-fetch']);
  assert.deepEqual(result.warnings, ['完整来源 1/3', '部分来源 2', '待复核 1', '告警 1', 'zzz：partial=true']);
});

test('只有人工图片待审时健康门禁保持可用但明确输出警告', () => {
  const result = evaluateStatus({ ...healthy, completeSources: 2, partialSources: 1, reviewCount: 1,
    issues: ['图片证据阻断'], games: { ...healthy.games, zzz: { error: '部分公告隔离或图片字节检查失败；保留旧事件', partial: true } } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.warnings, [
    '完整来源 2/3', '部分来源 1', '待复核 1', '告警 1',
    'zzz：部分公告隔离或图片字节检查失败；保留旧事件', 'zzz：partial=true',
  ]);
});
