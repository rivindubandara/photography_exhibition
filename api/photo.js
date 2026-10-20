const { checkAdmin, updatePhotoTitle, deletePhoto } = require('./_lib/airtable');

module.exports = async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'Unlock admin first.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    if (req.method === 'PATCH') {
      const { id, title } = body;
      if (!id) return res.status(400).json({ error: 'Missing photo id.' });
      if (title == null || !String(title).trim()) return res.status(400).json({ error: 'Enter a title.' });
      const photo = await updatePhotoTitle(id, title);
      return res.status(200).json({ ok: true, photo });
    }
    if (req.method === 'DELETE') {
      const id = body.id || new URL(req.url, 'http://x').searchParams.get('id');
      if (!id) return res.status(400).json({ error: 'Missing photo id.' });
      await deletePhoto(id);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'PATCH or DELETE only' });
  } catch (e) {
    res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e.message });
  }
};
