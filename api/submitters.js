const { checkAdmin, getSubmitters } = require('./_lib/airtable');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!checkAdmin(req)) return res.status(401).json({ error: 'Unlock admin first.' });
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ submitters: await getSubmitters() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
