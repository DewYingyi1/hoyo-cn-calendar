// Bounded recovery policy for the collection pipeline.
//
// Two and only two failures may justify another full collection pass:
//   1. a source request whose recorded error is *entirely* a fixed
//      `host：source-code` list and whose codes are all transient network codes;
//   2. an image-evidence record that is pending, explicitly retryable, not latched
//      for human review, still bound to an unchanged confirmed byte baseline, and
//      whose error code is a retryable network/read code (or a retryable HTTP status).
//
// Nothing here writes data, approves evidence, builds, notifies or publishes. The
// module only decides whether another pass is worth running and drives that pass
// through injected callbacks, so tests never sleep, touch the network or read data.
// Reasons and logs carry a fixed kind plus a game name only: never a raw error
// message, response body, URL, host or credential.

export const MAX_UPDATE_ROUNDS = 3;
export const RECOVERY_DELAYS_MS = [30000, 60000];

// Transient network kinds produced by networkFailure()/sources.mjs. Deterministic
// evidence errors (tls, http, format, size, response, invalid, processing) are
// excluded on purpose: retrying them would only repeat the same failure.
const transientSourceCodes = ['dns', 'connect', 'socket', 'timeout', 'fetch', 'read'];
const TRANSIENT_SOURCE_ERROR = new RegExp(
  `^(?:[a-z0-9.-]+：source-(?:${transientSourceCodes.join('|')}))(?:；[a-z0-9.-]+：source-(?:${transientSourceCodes.join('|')}))*$`,
);
const retryableImageErrorCodes = new Set(['image-fetch', 'image-request', 'image-read', 'image-timeout']);
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validByteBaseline = value => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length > 0 && Object.values(value).every(validDigest));
const safeGame = value => typeof value === 'string' && /^[a-z0-9-]+$/.test(value);
// Registry keys are `${game}:${source}:${postId}`; anything else is not a post record.
const registryGame = key => {
  const parts = String(key).split(':');
  return parts.length === 3 && parts.every(Boolean) && safeGame(parts[0]) ? parts[0] : null;
};
const retryableHttpStatus = status => Number.isInteger(status)
  && (status === 429 || (status >= 500 && status <= 599));

const sourceTransient = error => typeof error === 'string' && TRANSIENT_SOURCE_ERROR.test(error);

const imageFailureRetryable = record => {
  const code = record?.imageEvidenceErrorCode;
  if (retryableImageErrorCodes.has(code)) return true;
  return code === 'image-http' && retryableHttpStatus(record?.imageEvidenceDiagnostic?.httpStatus);
};

// A manual content/image lock, a missing or mismatched baseline, a non-retryable
// evidence error and image-budget (per-run cap, never a transient fault) all keep
// the record out of the retry set.
const imageTransient = record => record?.imageEvidenceRequired === true
  && record.imageEvidencePending === true
  && record.imageEvidenceRetryable === true
  && record.imageEvidenceManualReview !== true
  && record.imageEvidenceDiagnostic?.kind !== 'tls'
  && validDigest(record.digest)
  && record.confirmedImageBytesDigest === record.digest
  && validByteBaseline(record.confirmedImageBytes)
  && imageFailureRetryable(record);

export function recoveryReasons(status, posts) {
  const reasons = new Map();
  const add = (kind, game) => {
    if (!reasons.has(`${kind}:${game}`)) reasons.set(`${kind}:${game}`, { kind, game });
  };
  for (const [game, state] of Object.entries(status?.games ?? {})) {
    if (!safeGame(game)) continue;
    if (sourceTransient(state?.error)) add('source', game);
  }
  for (const [key, record] of Object.entries(posts ?? {})) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    if (record.imageEvidenceRequired !== true) continue;
    const game = registryGame(key);
    if (!game) continue;
    if (imageTransient(record)) add('image', game);
  }
  return [...reasons.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.game.localeCompare(b.game));
}

const summaryLine = (phase, attempts, remaining) => JSON.stringify({
  type: 'update-recovery',
  phase,
  attempts,
  remaining: remaining.map(({ kind, game }) => `${kind}:${game}`),
});

const delayFor = (delays, attempt) => {
  const value = delays[Math.min(attempt - 1, delays.length - 1)];
  return Number.isFinite(value) ? Math.max(0, value) : RECOVERY_DELAYS_MS.at(-1);
};

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// One pass at a time: the update callback must be fully awaited (the child exits and
// releases the repository lock) before state is read and before any wait begins.
// Update and state-read failures are never caught here: a crashed collection round
// must surface instead of being retried into a false recovery.
export async function updateWithRecovery({ update, readState, sleep = defaultSleep, log = () => {},
  retryDelaysMs = RECOVERY_DELAYS_MS } = {}) {
  if (typeof update !== 'function' || typeof readState !== 'function') {
    throw new TypeError('update-recovery-callbacks');
  }
  const delays = Array.isArray(retryDelaysMs) && retryDelaysMs.length ? retryDelaysMs : RECOVERY_DELAYS_MS;
  let attempts = 0;
  for (;;) {
    await update();
    attempts++;
    const state = await readState();
    const remaining = recoveryReasons(state?.status, state?.posts);
    if (!remaining.length) {
      log(summaryLine('complete', attempts, remaining));
      return { attempts, recovered: true, remaining: [] };
    }
    if (attempts >= MAX_UPDATE_ROUNDS) {
      log(summaryLine('exhausted', attempts, remaining));
      return { attempts, recovered: false, remaining };
    }
    log(summaryLine('retry', attempts, remaining));
    await sleep(delayFor(delays, attempts));
  }
}
