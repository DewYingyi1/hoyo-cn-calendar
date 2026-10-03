import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('电脑订阅说明保留WinCal链接、操作步骤及准确的Lite限制', async () => {
  const html = await fs.readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
  for (const text of [html, readme]) {
    assert.match(text, /https:\/\/github\.com\/ha0719\/WinCal\/releases\/latest/);
    assert.match(text, /ICS 订阅链接/);
    assert.match(text, /添加/);
    assert.match(text, /保存/);
    assert.match(text, /缓存/);
    assert.match(text, /手动刷新/);
    assert.match(text, /Rainlendar Lite 免费版不能原生订阅并自动刷新网络 ICS 链接/);
    assert.match(text, /Rainlendar Pro/);
    assert.match(text, /本地 ICS/);
    assert.match(text, /未在本机安装/);
  }
  assert.match(html, /id="windows-subscription-help"/);
  assert.match(html, /不是常驻桌面/);
});
