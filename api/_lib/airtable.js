const crypto = require('crypto');

const BASE = process.env.AIRTABLE_BASE_ID || 'apptoZsfDK2F6svew';
const MAX_VOTES = 3;
const T = {
  photos: 'tblhWa51xaJUvcq10', voters: 'tblTfafGBXSbZNjlU', votes: 'tblv3r3wm8aemQqkS',
  submitters: 'tbljpgMtgxx87nL4C',
};
const F = {
  photoId: 'fldlPt3UbBUfewc0B', title: 'fldHCeGSG2SpiNGrC', image: 'fldtyooTFQcC4Q3A9',
  photoSubmitter: 'fldQbQCOzjG3iRbpr', photoSubEmail: 'fldUSmC3UTJsWbzg4',
  submitterName: 'fldHwPd9QuSDAOdeD',
  voterName: 'fldhdc938ElDoGNpp', voterEmail: 'fld0hq9Ksv74OUzqb', voterVotes: 'fldy1X9rfiaiOfFiP',
  voteVoter: 'fldUV2H8hye4Zrbkm', votePhoto: 'fldSDc8ayUbmTB3k3',
};

const key = (email) => crypto.createHash('sha256')
  .update(String(email || '').trim().toLowerCase() + (process.env.KEY_SALT || 'nt')).digest('hex').slice(0, 16);

function adminToken() {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return null;
  return crypto.createHash('sha256')
    .update(`admin:${pw}:${process.env.KEY_SALT || 'nt'}`).digest('hex');
}

function checkAdmin(req) {
  const expected = adminToken();
  if (!expected) return false;
  const h = req.headers.authorization || req.headers.Authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return !!t && t === expected;
}

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

async function submitterNames() {
  const recs = await listAll(T.submitters, [F.submitterName]);
  const map = {};
  for (const r of recs) map[r.id] = r.fields[F.submitterName] || '';
  return map;
}

function mapPhoto(r, names = {}) {
  const f = r.fields; const img = first(f[F.image]);
  if (!img) return null;
  const subIds = f[F.photoSubmitter] || [];
  const submitter = subIds.map((id) => names[id]).filter(Boolean).join(', ');
  return {
    id: r.id, number: f[F.photoId] || '', title: f[F.title] || '',
    submitter,
    thumb: img.thumbnails?.large?.url || img.url, full: img.thumbnails?.full?.url || img.url,
    width: img.width, height: img.height,
    ownerKeys: (f[F.photoSubEmail] || []).map(key),
  };
}

async function getPhotos() {
  const [recs, names] = await Promise.all([
    listAll(T.photos, [F.photoId, F.title, F.image, F.photoSubmitter, F.photoSubEmail]),
    submitterNames(),
  ]);
  return recs.map((r) => mapPhoto(r, names)).filter(Boolean)
    .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
}

async function nextPhotoNumber() {
  const recs = await listAll(T.photos, [F.photoId]);
  let max = 0;
  for (const r of recs) {
    const n = parseInt(String(r.fields[F.photoId] || '').replace(/\D/g, ''), 10);
    if (n > max) max = n;
  }
  return String(max + 1).padStart(3, '0');
}

async function uploadAttachment(recordId, { contentType, file, filename }) {
  const r = await fetch(`https://content.airtable.com/v0/${BASE}/${recordId}/${F.image}/uploadAttachment`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ contentType, file, filename }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j?.error?.message || `Airtable upload ${r.status}`); e.status = r.status; throw e; }
  return j;
}

/** Create a photo from a public image URL (Airtable fetches it). */
async function createPhotoFromUrl({ title, number, url, filename }) {
  const photoId = number || await nextPhotoNumber();
  const j = await at(`${T.photos}?returnFieldsByFieldId=true`, {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        [F.photoId]: photoId,
        [F.title]: title || '',
        [F.image]: [{ url, ...(filename ? { filename } : {}) }],
      },
    }),
  });
  return mapPhoto(j) || { id: j.id, number: photoId, title: title || '' };
}

async function getSubmitters() {
  const recs = await listAll(T.submitters, [F.submitterName]);
  return recs
    .map((r) => ({ id: r.id, name: r.fields[F.submitterName] || '' }))
    .filter((s) => s.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Create a photo then attach base64 file bytes (≤5 MB). */
async function createPhotoFromUpload({ title, number, contentType, file, filename, submitterId }) {
  if (!submitterId || !/^rec\w{14}$/.test(submitterId)) {
    const e = new Error('Choose whose photo this is.');
    e.status = 400;
    throw e;
  }
  const photoId = number || await nextPhotoNumber();
  const created = await at(`${T.photos}?returnFieldsByFieldId=true`, {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        [F.photoId]: photoId,
        [F.title]: title || '',
        [F.photoSubmitter]: [submitterId],
      },
    }),
  });
  const updated = await uploadAttachment(created.id, {
    contentType: contentType || 'image/jpeg',
    file,
    filename: filename || `${photoId}.jpg`,
  });
  const names = await submitterNames();
  return mapPhoto(updated, names) || {
    id: created.id, number: photoId, title: title || '', submitter: names[submitterId] || '',
  };
}

async function votesByVoter() {
  const recs = await listAll(T.votes, [F.voteVoter, F.votePhoto]);
  const map = {};
  for (const r of recs) {
    const voterId = first(r.fields[F.voteVoter]);
    const photoId = first(r.fields[F.votePhoto]);
    if (!voterId || !photoId) continue;
    (map[voterId] || (map[voterId] = [])).push(photoId);
  }
  return map;
}

async function getVoters() {
  const [recs, byVoter] = await Promise.all([
    listAll(T.voters, [F.voterName, F.voterEmail, F.voterVotes]),
    votesByVoter(),
  ]);
  return recs
    .map((r) => {
      const votedPhotoIds = byVoter[r.id] || [];
      const votes = Math.max((r.fields[F.voterVotes] || []).length, votedPhotoIds.length);
      return {
        id: r.id,
        name: r.fields[F.voterName] || '',
        key: key(r.fields[F.voterEmail]),
        votes,
        remaining: Math.max(0, MAX_VOTES - votes),
        votedPhotoIds,
        voted: votes >= MAX_VOTES,
      };
    })
    .filter((v) => v.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function castVote(voterId, photoId) {
  const [v, p, byVoter] = await Promise.all([
    at(`${T.voters}/${voterId}?returnFieldsByFieldId=true`),
    at(`${T.photos}/${photoId}?returnFieldsByFieldId=true`),
    votesByVoter(),
  ]);
  const votedPhotoIds = byVoter[voterId] || [];
  const votes = Math.max((v.fields[F.voterVotes] || []).length, votedPhotoIds.length);
  if (votes >= MAX_VOTES) return { status: 409, error: `You’ve already used all ${MAX_VOTES} votes.` };
  if (votedPhotoIds.includes(photoId)) return { status: 409, error: 'You already voted for this photo.' };
  const mine = (p.fields[F.photoSubEmail] || []).map((e) => String(e).toLowerCase());
  if (mine.includes(String(v.fields[F.voterEmail] || '').toLowerCase())) return { status: 403, error: "You can't vote for your own photo." };
  await at(T.votes, { method: 'POST', body: JSON.stringify({ fields: { [F.voteVoter]: [voterId], [F.votePhoto]: [photoId] } }) });
  const next = votes + 1;
  return { status: 200, ok: true, votes: next, remaining: MAX_VOTES - next, maxVotes: MAX_VOTES };
}

async function updatePhotoTitle(photoId, title) {
  if (!/^rec\w{14}$/.test(photoId || '')) {
    const e = new Error('Bad photo id'); e.status = 400; throw e;
  }
  const names = await submitterNames();
  const j = await at(`${T.photos}/${photoId}?returnFieldsByFieldId=true`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: { [F.title]: String(title || '').trim().slice(0, 120) } }),
  });
  return mapPhoto(j, names) || { id: photoId, title: String(title || '').trim() };
}

async function deletePhoto(photoId) {
  if (!/^rec\w{14}$/.test(photoId || '')) {
    const e = new Error('Bad photo id'); e.status = 400; throw e;
  }
  // Remove vote records that point at this photo first (keeps Votes table clean)
  const votes = await listAll(T.votes, [F.votePhoto]);
  const doomed = votes.filter((r) => first(r.fields[F.votePhoto]) === photoId).map((r) => r.id);
  for (let i = 0; i < doomed.length; i += 10) {
    const chunk = doomed.slice(i, i + 10);
    const q = new URLSearchParams();
    chunk.forEach((id) => q.append('records[]', id));
    await at(`${T.votes}?${q}`, { method: 'DELETE' });
  }
  await at(`${T.photos}/${photoId}`, { method: 'DELETE' });
  return { ok: true, id: photoId };
}

module.exports = {
  getPhotos, getVoters, getSubmitters, castVote, checkAdmin, adminToken, MAX_VOTES,
  createPhotoFromUrl, createPhotoFromUpload, updatePhotoTitle, deletePhoto, nextPhotoNumber, F, T,
};
