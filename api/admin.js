const { checkAdmin, adminToken } = require('./_lib/airtable');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'ADMIN_PASSWORD is not configured on the server.' });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    if (body.password && String(body.password) === process.env.ADMIN_PASSWORD) {
      return res.status(200).json({ ok: true, token: adminToken() });
    }
    if (checkAdmin(req)) return res.status(200).json({ ok: true, token: adminToken() });
    return res.status(401).json({ error: 'Wrong password.' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
