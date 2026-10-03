export async function selectSource(game, config, { website }) {
  return { result: await website(game, config), source: 'website' };
}

// Validate the raw input source, not its canonical identity (which may be historical).
export function isWebsiteInput(post, configs) {
  const website = configs[post.game]?.website;
  return Boolean(website && post.source === 'website' && post.official === true && post.id && post.url === website.urlBase + post.id);
}
