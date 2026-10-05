import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { officialURL, safeErrorCodes } from '../scripts/diagnose-official-network.mjs';

test('诊断只接受既有三款国服官网原地址与栏目', async () => {
  const configs = JSON.parse(await fs.readFile(new URL('../sources/games.json', import.meta.url), 'utf8'));
  for (const [game, config] of Object.entries(configs)) {
    const url = new URL(officialURL(game, config));
    assert.equal(url.origin, 'https://act-api-takumi-static.mihoyo.com');
    assert.equal(url.searchParams.get('iPageSize'), '100');
    assert.throws(() => officialURL(game, { website: { ...config.website, base: 'https://evil.test' } }));
    assert.throws(() => officialURL(game, { website: { ...config.website, channel: 1 } }));
  }
  assert.throws(() => officialURL('other', {}));
});

test('错误仅输出固定安全码，不输出异常正文、任意code或凭据', () => {
  const error = new Error('PRIVATE_BODY_OR_TOKEN');
  error.code = 'PRIVATE_CODE';
  error.cause = { errors: [{ code: 'ETIMEDOUT' }, { code: 'ENETUNREACH' }, { code: 'PRIVATE_CODE' }] };
  assert.deepEqual(safeErrorCodes(error), ['ETIMEDOUT', 'ENETUNREACH']);
  assert.deepEqual(safeErrorCodes(new Error('PRIVATE_BODY_OR_TOKEN')), ['NETWORK_OTHER']);
  error.cause.cause = error;
  assert.deepEqual(safeErrorCodes(error), ['ETIMEDOUT', 'ENETUNREACH']);
});

test('诊断工作流无写权限、密钥、采集入库和Pages部署', async () => {
  const workflow = await fs.readFile(new URL('../.github/workflows/official-network-diagnostic.yml', import.meta.url), 'utf8');
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /branches: \['diag\/official-network-\*'\]/);
  assert.doesNotMatch(workflow, /secrets|write|npm run update|scripts\/update|deploy-pages|git push|workflow_dispatch/);
});
