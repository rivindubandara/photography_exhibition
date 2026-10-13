const { getPhotos } = require('./_lib/airtable');
module.exports = async (req, res) => {
  try {
    const photos = await getPhotos();
    // image URLs from Airtable expire after ~2h, so keep the cache short
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=60');
    res.status(200).json({ photos });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
