const { checkAdmin, createPhotoFromUpload } = require('./_lib/airtable');

const MAX_BYTES = 4.5 * 1024 * 1024; // stay under typical serverless body limits
const OK_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!checkAdmin(req)) return res.status(401).json({ error: 'Unlock admin first.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const { title, number, contentType, file, filename } = body;
    if (!file || typeof file !== 'string') return res.status(400).json({ error: 'Missing image data.' });
    const type = String(contentType || 'image/jpeg').toLowerCase();
    if (!OK_TYPES.has(type)) return res.status(400).json({ error: 'Use JPEG, PNG, WebP, or GIF.' });
    // rough size check from base64
    const approx = Math.floor(file.length * 0.75);
    if (approx > MAX_BYTES) return res.status(413).json({ error: 'Image too large (max ~4.5 MB).' });

    const photo = await createPhotoFromUpload({
      title: String(title || '').trim().slice(0, 120),
      number: number ? String(number).trim().slice(0, 16) : undefined,
      contentType: type,
      file: file.replace(/^data:[^;]+;base64,/, ''),
      filename: String(filename || 'photo.jpg').replace(/[^\w.\-]+/g, '_').slice(0, 80),
    });
    res.status(200).json({ ok: true, photo });
  } catch (e) {
    res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e.message });
  }
};
