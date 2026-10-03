import { createHash } from 'node:crypto';

export const sourceKey = post => `${post.game}:${post.source}:${post.id}`;
export const normalizedTitle = title => String(title).normalize('NFKC').replace(/[\s「」『』《》【】“”"'：:，,！!。·•\-—]/g, '').toLowerCase();
export function titleFingerprint(post) {
  return createHash('sha256').update(`${post.game}:${normalizedTitle(post.title)}`).digest('hex');
}
export function findCanonical(post, registry, aliases) {
  const key = sourceKey(post);
  if (aliases[key]) return aliases[key];
  const title = normalizedTitle(post.title);
  const possible = Object.entries(registry).filter(([other, record]) => {
    const [game, source] = other.split(':');
    return game === post.game && source !== post.source && normalizedTitle(record.title) === title && Math.abs(Date.parse(record.published) - Date.parse(post.published)) <= 86400000;
  });
  if (possible.length === 1) {
    const canonical = aliases[possible[0][0]] ?? possible[0][0];
    aliases[key] = canonical;
    return canonical;
  }
  return key;
}
export function canonicalPrefix(key, aliases) { return aliases[key] ?? key; }
export function canonicalPost(post, canonical) {
  const [, source, id] = canonical.split(':');
  return { ...post, source, id };
}
export function isHandled(prefix, overrides) {
  return overrides.events.some(event => event.id === prefix || event.id.startsWith(prefix + ':')) || overrides.suppressPostIds.includes(prefix) || overrides.suppressPostIds.includes(prefix.split(':')[2]);
}
