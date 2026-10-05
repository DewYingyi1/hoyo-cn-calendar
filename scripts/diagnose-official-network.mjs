import fs from 'node:fs/promises';
import dns from 'node:dns/promises';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HOST = 'act-api-takumi-static.mihoyo.com';
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const HEADERS = { 'User-Agent': 'hoyo-cn-calendar/0.1 public-announcements', Accept: 'application/json' };
const CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER', 'DIAG_TIMEOUT', 'DIAG_SIZE']);

// Only fixed codes are emitted: never messages, request URLs, headers or response bodies.
export function safeErrorCodes(error) {
  const codes = new Set();
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 5) return;
    seen.add(value);
    if (CODES.has(value.code)) codes.add(value.code);
    if (value.name === 'TimeoutError') codes.add('DIAG_TIMEOUT');
    visit(value.cause, depth + 1);
    if (Array.isArray(value.errors)) for (const child of value.errors.slice(0, 8)) visit(child, depth + 1);
  };
  visit(error);
  return [...codes].length ? [...codes] : ['NETWORK_OTHER'];
}

export function officialURL(game, config) {
  const allowed = { genshin: ['16471662a82d418a', 720], starrail: ['1963de8dc19e461c', 255], zzz: ['706fd13a87294881', 273] };
  const expected = allowed[game];
  if (!expected || config?.website?.base !== `https://${HOST}` || config.website.app !== expected[0] || config.website.channel !== expected[1]) {
    throw new Error('DIAG_CONFIG_INVALID');
  }
  return `https://${HOST}/content_v2_user/app/${expected[0]}/getContentList?iChanId=${expected[1]}&iPageSize=100&iPage=1&sLangKey=zh-cn`;
}

function summarize(status, headers, bytes) {
  const type = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const result = { status, jsonType: type === 'application/json', bytes: bytes.length };
  if (status === 200 && result.jsonType) {
    try {
      const json = JSON.parse(bytes.toString('utf8'));
      result.validList = json.retcode === 0 && Array.isArray(json.data?.list);
      if (result.validList) result.listCount = json.data.list.length;
    } catch { result.validList = false; }
  }
  return result;
}

async function defaultFetch(url) {
  const response = await fetch(url, { headers: HEADERS, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw Object.assign(new Error(), { code: 'DIAG_SIZE' });
  }
  const parts = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_BYTES) throw Object.assign(new Error(), { code: 'DIAG_SIZE' });
    parts.push(chunk);
  }
  return summarize(response.status, { 'content-type': response.headers.get('content-type') }, Buffer.concat(parts));
}

function ipv4Https(url) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const request = https.get(url, { family: 4, headers: HEADERS }, response => {
      // Native HTTPS does not follow redirects; certificate verification remains enabled.
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) request.destroy(Object.assign(new Error(), { code: 'DIAG_SIZE' }));
        else chunks.push(chunk);
      });
      response.once('error', finishError);
      response.once('end', () => { clearTimeout(timer); resolve(summarize(response.statusCode, response.headers, Buffer.concat(chunks))); });
    });
    const timer = setTimeout(() => request.destroy(Object.assign(new Error(), { code: 'DIAG_TIMEOUT' })), TIMEOUT_MS);
    function finishError(error) { clearTimeout(timer); reject(error); }
    request.once('error', finishError);
  });
}

export async function diagnose(configs) {
  // Validate all targets before making any network request.
  const targets = ['genshin', 'starrail', 'zzz'].map(game => ({ game, url: officialURL(game, configs[game]) }));
  console.log(JSON.stringify({ node: process.version, platform: process.platform, host: HOST }));
  try {
    const addresses = await dns.lookup(HOST, { all: true });
    console.log(JSON.stringify({ dnsFamilies: [...new Set(addresses.map(a => a.family))] }));
  } catch (error) { console.log(JSON.stringify({ dnsCodes: safeErrorCodes(error) })); }
  for (const { game, url } of targets) {
    for (const [transport, request] of [['default-fetch', defaultFetch], ['ipv4-https', ipv4Https]]) {
      const start = Date.now();
      try {
        const result = await request(url);
        console.log(JSON.stringify({ game, transport, ms: Date.now() - start, ...result }));
      }
      catch (error) { console.log(JSON.stringify({ game, transport, ms: Date.now() - start, codes: safeErrorCodes(error) })); }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const configs = JSON.parse(await fs.readFile(new URL('../sources/games.json', import.meta.url), 'utf8'));
    await diagnose(configs);
  } catch {
    console.error('DIAG_FAILED');
    process.exitCode = 1;
  }
}
