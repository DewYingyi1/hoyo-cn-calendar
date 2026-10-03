import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('头像与站点图标使用本地素材，旋转卡片不再裁切', async () => {
  const html = await fs.readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../site/style.css', import.meta.url), 'utf8');
  assert.match(html, /<img class="brand-icon" src="assets\/site-avatar\.png"/);
  assert.doesNotMatch(html, /class="brand-icon"[^>]*>日/);
  assert.match(html, /rel="icon" href="assets\/favicon\.ico"/);
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(css, /\.hero \{[^}]*overflow: visible/);
  assert.match(css, /\.hero-aside \{[^}]*right: 24px/);
  for (const name of ['site-avatar.png', 'favicon-32.png', 'favicon-48.png', 'apple-touch-icon.png']) {
    const image = await fs.readFile(new URL('../site/assets/' + name, import.meta.url));
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(image.readUInt32BE(16), image.readUInt32BE(20));
  }
  const ico = await fs.readFile(new URL('../site/assets/favicon.ico', import.meta.url));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);
});
