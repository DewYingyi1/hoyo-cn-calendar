// A successful maintenance parse need not resolve the rest of a version roundup.
export function updateReview(reviews, key, parsed, { source, now, handled = false, changed = false }) {
  const previous = reviews.get(key);
  if (parsed.review) {
    reviews.set(key, { ...parsed.review, source, firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now, resolved: handled && !changed, changedConfirmation: changed });
  } else if (parsed.event) {
    reviews.delete(key);
  } else if (parsed.ignored && previous && !previous.resolved) {
    // Classification becoming empty is not proof that an unresolved schedule was fixed.
    reviews.set(key, { ...previous, lastSeenAt: now });
  } else if (parsed.ignored) reviews.delete(key);
}

export function retainReviews(reviews, now) {
  const cutoff = Date.parse(now) - 100 * 86400000;
  return [...reviews].filter(review => !review.resolved || Date.parse(review.firstSeenAt) >= cutoff);
}
