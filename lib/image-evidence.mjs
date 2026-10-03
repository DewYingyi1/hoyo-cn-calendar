import { createHash } from 'node:crypto';

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGES_PER_POST = 32;
export const MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validHashMap = value => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length && Object.values(value).every(validHash));

export function isOfficialImageURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && ['mihoyo.com', 'hoyoverse.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain));
  } catch { return false; }
}

// Byte evidence only: GIFs are hashed like any other image, never sent to a model.
export async function loadImageBytes(url, { request = fetch, timeoutMs = 20000, consumeBytes } = {}) {
  if (!isOfficialImageURL(url)) throw new Error('image-domain');
  const controller = new AbortController();
  let timer;
  let reader;
  let response;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('image-timeout')); }, Math.min(20000, Math.max(1, timeoutMs)));
  });
  const download = async () => {
    try { response = await request(url, { redirect: 'error', signal: controller.signal }); }
    catch { throw new Error('image-fetch'); }
    if (!response.ok || response.redirected) throw new Error('image-http');
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) throw new Error('image-format');
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('image-size');
    if (!response.body) throw new Error('image-body');
    reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) throw new Error('image-size');
      if (consumeBytes && consumeBytes(value.byteLength) === false) throw new Error('image-budget');
      chunks.push(Buffer.from(value));
    }
    if (!total) throw new Error('image-body');
    return { sha256: sha256(Buffer.concat(chunks)), size: total, mime };
  };
  try { return await Promise.race([download(), timeout]); }
  finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
  }
}

const failureReasons = {
  'image-domain': '图片不在官方域名白名单',
  'image-timeout': '图片字节检查超时',
  'image-fetch': '图片获取失败或发生重定向',
  'image-http': '图片HTTP错误或发生重定向',
  'image-format': '图片内容格式不可用',
  'image-size': '图片超过16MiB',
  'image-body': '图片字节为空或不可读取',
  'image-empty': '图片证据公告没有可检查的图片',
  'image-count': '单篇公告图片数量超过检查上限',
  'image-budget': '本轮图片字节检查超过总预算',
};

// One checker per update: bounded global concurrency and per-run URL deduplication.
// Only explicitly flagged posts are downloaded. Observations NEVER become confirmations.
export function createImageEvidenceChecker({ request = fetch, concurrency = 2, timeoutMs = 20000,
  maxImagesPerPost = MAX_IMAGES_PER_POST, maxTotalBytes = MAX_TOTAL_IMAGE_BYTES } = {}) {
  const limit = Math.min(4, Math.max(1, Math.floor(concurrency) || 2));
  const imageLimit = Math.min(MAX_IMAGES_PER_POST, Math.max(1, Math.floor(maxImagesPerPost) || MAX_IMAGES_PER_POST));
  const byteLimit = Math.min(MAX_TOTAL_IMAGE_BYTES, Math.max(1, Math.floor(maxTotalBytes) || MAX_TOTAL_IMAGE_BYTES));
  const queue = [];
  const cache = new Map();
  let active = 0;
  let consumedBytes = 0;
  const consumeBytes = size => {
    if (consumedBytes + size > byteLimit) return false;
    consumedBytes += size;
    return true;
  };
  const pump = () => {
    while (active < limit && queue.length) {
      const { url, resolve, reject } = queue.shift();
      active++;
      loadImageBytes(url, { request, timeoutMs, consumeBytes }).then(resolve, reject).finally(() => { active--; pump(); });
    }
  };
  const observe = url => {
    if (!cache.has(url)) cache.set(url, new Promise((resolve, reject) => { queue.push({ url, resolve, reject }); pump(); }));
    return cache.get(url);
  };
  return async (post, reference, { expectedDigest, digest, now }) => {
    if (reference?.imageEvidenceRequired !== true) return { required: false, needsReview: false, fields: {} };
    const urls = [...new Set(post.images ?? [])];
    let observed;
    let failure;
    try {
      if (!urls.length) throw new Error('image-empty');
      if (urls.length > imageLimit) throw new Error('image-count');
      const values = await Promise.all(urls.map(observe));
      observed = Object.fromEntries(urls.map((url, index) => [url, values[index].sha256]));
    } catch (error) {
      // Do not log remote error messages, URLs, bodies, credentials or partial observations.
      failure = failureReasons[error.message] ?? '图片字节检查失败';
    }
    const baseline = reference.confirmedImageBytes;
    const baselineValid = Boolean(expectedDigest && expectedDigest === digest && reference.confirmedImageBytesDigest === expectedDigest
      && validHashMap(baseline));
    const bytesChanged = Boolean(observed && baselineValid && (Object.keys(baseline).length !== urls.length
      || urls.some(url => baseline[url] !== observed[url])));
    const needsReview = Boolean(failure || !baselineValid || bytesChanged || reference.imageEvidencePending);
    const reason = failure ?? (!baselineValid ? '图片证据尚无绑定当前人工确认正文的字节基线，须人工建立基线'
      : bytesChanged ? '人工确认后官方图片字节或图片列表已修改，须重新核对'
        : reference.imageEvidencePending ? '图片证据仍待人工复核；观察一致不会自动清除待审' : null);
    return {
      required: true, needsReview, bytesChanged, baselineMissing: !baselineValid, failure, reason,
      fields: {
        ...(observed ? { observedImageBytes: observed, observedImageBytesDigest: digest, observedImageBytesAt: now } : {}),
        imageEvidenceCheckedAt: now,
        imageEvidenceError: failure ?? null,
        imageEvidencePending: needsReview,
      },
    };
  };
}

// Explicit maintenance action only. A first observation never calls this function by
// itself: the caller must already have recorded a human confirmation for this exact
// current body digest.
export function approveImageEvidence(reference, confirmedDigest) {
  if (!reference || reference.imageEvidenceRequired !== true) throw new Error('image-approval-not-required');
  if (!validHash(confirmedDigest) || reference.digest !== confirmedDigest) throw new Error('image-approval-digest');
  if (reference.observedImageBytesDigest !== confirmedDigest || !validHashMap(reference.observedImageBytes)) throw new Error('image-approval-observation');
  if (reference.imageEvidenceError) throw new Error('image-approval-error');
  if (!validHash(reference.imagesHash)) throw new Error('image-approval-images');
  return {
    ...reference,
    reviewedDigest: confirmedDigest,
    confirmedImagesHash: reference.imagesHash,
    confirmedImagesDigest: confirmedDigest,
    confirmedImageBytes: structuredClone(reference.observedImageBytes),
    confirmedImageBytesDigest: confirmedDigest,
    imageEvidencePending: false,
    imageEvidenceError: null,
  };
}
