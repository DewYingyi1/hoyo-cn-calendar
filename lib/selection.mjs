export async function selectSource(game, config, { website, forum, websiteOnly = false }) {
  try { return { result: await website(game, config), source: 'website', primaryError: null }; }
  catch (error) {
    if (websiteOnly) throw error;
    try { return { result: await forum(game, config), source: 'miyoushe', primaryError: error.message }; }
    catch (fallbackError) { throw new Error(`官网：${error.message}；米游社备用：${fallbackError.message}`); }
  }
}
