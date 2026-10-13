const crypto = require('crypto');

const BASE = process.env.AIRTABLE_BASE_ID || 'apptoZsfDK2F6svew';
const T = { photos: 'tblhWa51xaJUvcq10', voters: 'tblTfafGBXSbZNjlU', votes: 'tblv3r3wm8aemQqkS' };
const F = {
  photoId: 'fldlPt3UbBUfewc0B', title: 'fldHCeGSG2SpiNGrC', image: 'fldtyooTFQcC4Q3A9',
  photoSubEmail: 'fldUSmC3UTJsWbzg4',
  voterName: 'fldhdc938ElDoGNpp', voterEmail: 'fld0hq9Ksv74OUzqb', voterVotes: 'fldy1X9rfiaiOfFiP',
  voteVoter: 'fldUV2H8hye4Zrbkm', votePhoto: 'fldSDc8ayUbmTB3k3',
};

const key = (email) => crypto.createHash('sha256')
  .update(String(email || '').trim().toLowerCase() + (process.env.KEY_SALT || 'nt')).digest('hex').slice(0, 16);

async function at(path, opts = {}) {
  const r = await fetch(`https://api.airtable.com/v0/${BASE}/${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j?.error?.message || `Airtable ${r.status}`); e.status = r.status; throw e; }
  return j;
}

async function listAll(table, fields) {
  const out = []; let offset;
  do {
    const q = new URLSearchParams({ returnFieldsByFieldId: 'true', pageSize: '100' });
    fields.forEach((f) => q.append('fields[]', f));
    if (offset) q.set('offset', offset);
    const j = await at(`${table}?${q}`);
    out.push(...j.records); offset = j.offset;
  } while (offset);
  return out;
}

const first = (v) => (Array.isArray(v) ? v[0] : v);

async function getPhotos() {
  const recs = await listAll(T.photos, [F.photoId, F.title, F.image, F.photoSubEmail]);
  return recs
    .map((r) => {
      const f = r.fields; const img = first(f[F.image]);
      if (!img) return null;
      return {
        id: r.id, number: f[F.photoId] || '', title: f[F.title] || '',
        thumb: img.thumbnails?.large?.url || img.url, full: img.thumbnails?.full?.url || img.url,
        width: img.width, height: img.height,
        ownerKeys: (f[F.photoSubEmail] || []).map(key),
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
}

async function getVoters() {
  const recs = await listAll(T.voters, [F.voterName, F.voterEmail, F.voterVotes]);
  return recs
    .map((r) => ({ id: r.id, name: r.fields[F.voterName] || '', key: key(r.fields[F.voterEmail]), voted: (r.fields[F.voterVotes] || []).length > 0 }))
    .filter((v) => v.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function castVote(voterId, photoId) {
  const [v, p] = await Promise.all([
    at(`${T.voters}/${voterId}?returnFieldsByFieldId=true`),
    at(`${T.photos}/${photoId}?returnFieldsByFieldId=true`),
  ]);
  if ((v.fields[F.voterVotes] || []).length) return { status: 409, error: 'This name has already voted.' };
  const mine = (p.fields[F.photoSubEmail] || []).map((e) => String(e).toLowerCase());
  if (mine.includes(String(v.fields[F.voterEmail] || '').toLowerCase())) return { status: 403, error: "You can't vote for your own photo." };
  await at(T.votes, { method: 'POST', body: JSON.stringify({ fields: { [F.voteVoter]: [voterId], [F.votePhoto]: [photoId] } }) });
  return { status: 200, ok: true };
}

module.exports = { getPhotos, getVoters, castVote };
