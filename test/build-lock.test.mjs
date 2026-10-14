import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { listenForRepositoryLock } from '../scripts/build.mjs';

class FakeServer extends EventEmitter {
  calls = [];
  constructor(errors) { super(); this.errors = [...errors]; }
  listen(options) {
    this.calls.push(options);
    const code = this.errors.shift();
    queueMicrotask(() => code ? this.emit('error', Object.assign(new Error(code), { code })) : this.emit('listening'));
  }
}
const noListeners = server => {
  assert.equal(server.listenerCount('error'), 0);
  assert.equal(server.listenerCount('listening'), 0);
};
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

test('发布锁：首次成功不等待，清理监听器', async () => {
  const server = new FakeServer([]);
  await listenForRepositoryLock(server, { port: 23456, wait: () => assert.fail('不应等待') });
  assert.deepEqual(server.calls, [{ host: '127.0.0.1', port: 23456, exclusive: true }]);
  noListeners(server);
});

test('发布锁：短暂占用只重试同一端口，第二及第三次可成功', async () => {
  for (const failures of [1, 2]) {
    const server = new FakeServer(Array(failures).fill('EADDRINUSE'));
    const waits = [];
    await listenForRepositoryLock(server, { port: 23456, wait: async ms => { noListeners(server); waits.push(ms); } });
    assert.deepEqual(waits, [1000, 3000].slice(0, failures));
    assert.equal(server.calls.length, failures + 1);
    assert.ok(server.calls.every(options => options.host === '127.0.0.1' && options.port === 23456 && options.exclusive === true));
    noListeners(server);
  }
});

test('发布锁：持续占用三次后失败，不换端口、不无限重试', async () => {
  const server = new FakeServer(Array(4).fill('EADDRINUSE'));
  const waits = [];
  await assert.rejects(listenForRepositoryLock(server, { port: 23456, wait: async ms => waits.push(ms) }), error => {
    assert.match(error.message, /已有构建持有发布锁/);
    assert.equal(error.code, 'EADDRINUSE');
    assert.equal(error.cause.code, 'EADDRINUSE');
    assert.equal(error.attempts, 3);
    return true;
  });
  assert.deepEqual(waits, [1000, 3000]);
  assert.equal(server.calls.length, 3);
  assert.ok(server.calls.every(options => options.port === 23456));
  noListeners(server);
});

test('发布锁：非地址占用及同步监听错误立即失败', async () => {
  for (const synchronous of [false, true]) {
    const server = new FakeServer(['EACCES']);
    if (synchronous) server.listen = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    await assert.rejects(listenForRepositoryLock(server, { wait: () => assert.fail('不应重试') }), error => {
      assert.equal(error.message, '发布锁端口失败：EACCES');
      assert.equal(error.code, 'EACCES');
      assert.equal(error.attempts, 1);
      return true;
    });
    noListeners(server);
  }
});

test('发布锁：重试中出现其他错误立即停止，不耗尽剩余重试', async () => {
  const server = new FakeServer(['EADDRINUSE', 'EACCES']);
  const waits = [];
  await assert.rejects(listenForRepositoryLock(server, { wait: async ms => waits.push(ms) }), { code: 'EACCES', attempts: 2 });
  assert.deepEqual(waits, [1000]);
  assert.equal(server.calls.length, 2);
  noListeners(server);
});

test('发布锁：真实端口占用不允许进入，释放后同一server与端口可恢复', async () => {
  const blocker = net.createServer();
  const contender = net.createServer();
  try {
    await listenForRepositoryLock(blocker, { port: 0 });
    const port = blocker.address().port;
    await assert.rejects(listenForRepositoryLock(contender, { port, wait: async () => {} }), { code: 'EADDRINUSE', attempts: 3 });
    assert.equal(contender.listening, false);
    noListeners(contender);
    let waits = 0;
    await listenForRepositoryLock(contender, { port, wait: async ms => {
      assert.equal(ms, 1000);
      assert.equal(contender.listening, false);
      waits++;
      await close(blocker);
    } });
    assert.equal(waits, 1);
    assert.equal(contender.address().port, port);
    noListeners(contender);
  } finally {
    if (blocker.listening) await close(blocker);
    if (contender.listening) await close(contender);
  }
});
