const { getVoters } = require('./_lib/airtable');
module.exports = async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ voters: await getVoters() });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
