// Return only fixed categories. Never expose exception messages, addresses,
// request paths, credentials or certificate contents.
export function networkFailure(error) {
  const queue = [error];
  const seen = new Set();
  for (let i = 0; i < queue.length && i < 12; i++) {
    const item = queue[i];
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const code = item.code;
    if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'].includes(code)) return 'dns';
    if (['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(code)) return 'connect';
    if (typeof code === 'string' && (/^ERR_(?:TLS|SSL)_/.test(code)
      || ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code))) return 'tls';
    if (['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE'].includes(code)) return 'socket';
    if (['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code) || item.name === 'TimeoutError') return 'timeout';
    if (item.cause) queue.push(item.cause);
    if (Array.isArray(item.errors)) queue.push(...item.errors.slice(0, 4));
  }
  return 'unknown';
}
