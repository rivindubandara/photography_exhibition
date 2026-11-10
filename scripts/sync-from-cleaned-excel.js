/**
 * Sync cleaned Excel → Airtable/website, using Desktop\Submission for new images.
 *
 *   node scripts/sync-from-cleaned-excel.js           # dry-run
 *   node scripts/sync-from-cleaned-excel.js --apply
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const heicConvert = require('heic-convert');

try {
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) return;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  });
} catch {}

const {
  getPhotos, getSubmitters, createPhotoFromUpload, deletePhoto, renumberPhotosAlpha, at, T, F,
} = require('../api/_lib/airtable');

const APPLY = process.argv.includes('--apply');
const XLSX = process.argv.find((a, i) => i > 1 && !a.startsWith('--'))
  || path.join(process.env.USERPROFILE || '', 'Downloads', 'NT Photography Exhibition 2026 — Submissions 1.xlsx');
const SUB = 'C:\\Users\\RivinduB\\Desktop\\Submission';
const HEIC_EXT = new Set(['.heic', '.heif']);
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.heic', '.heif']);

function soft(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}
function norm(s) {
  return soft(s)
    .toLowerCase()
    .replace(/^title\s*[:\-–]\s*/i, '')
    .replace(/[^\w\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function cleanTitle(t) {
  let s = soft(t).replace(/^title\s*[:\-–]\s*/i, '');
  // Excel OCR-ish Il/Ill for II/III
  s = s.replace(/\bAnonymous\s+Ill\b/i, 'Anonymous III').replace(/\bAnonymous\s+Il\b/i, 'Anonymous II');
  return s;
}
function blurbCore(s) {
  return soft(s)
    .replace(/Device\(s\)?\s*used to take the photo:?\s*.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function titleKey(author, title) {
  return `${norm(author)}|${norm(cleanTitle(title))}`;
}

function readExcel(file) {
  const py = `
from openpyxl import load_workbook
import json, sys
wb = load_workbook(sys.argv[1], data_only=True)
ws = wb.active
headers = [ws.cell(1, c).value for c in range(1, ws.max_column + 1)]
def idx(n):
  return headers.index(n) + 1 if n in headers else None
cols = {k: idx(n) for k, n in [
  ('number','Submission ID'),('title','Title'),('subject','Subject'),
  ('blurb','Blurb'),('author','Author'),('device','Device')]}
rows = []
for r in range(2, ws.max_row + 1):
  row = {}
  for k, c in cols.items():
    val = ws.cell(r, c).value if c else None
    row[k] = '' if val is None else str(val).strip()
  if row.get('number','').isdigit(): row['number'] = row['number'].zfill(3)
  rows.append(row)
print(json.dumps(rows))
`;
  return JSON.parse(execFileSync('python', ['-c', py, file], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  }));
}

function walkImages(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('~$') || ent.name === '_Archive' || ent.name === 'Archive') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (/^_?archive$/i.test(ent.name) || ent.name.startsWith('.')) continue;
      out.push(...walkImages(p));
    } else if (IMG_EXT.has(path.extname(ent.name).toLowerCase())) {
      out.push(p);
    }
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function findPersonDir(author) {
  if (!fs.existsSync(SUB)) return null;
  const want = norm(author);
  const dirs = fs.readdirSync(SUB, { withFileTypes: true }).filter((d) => d.isDirectory());
  let best = null, score = 0;
  for (const d of dirs) {
    const n = norm(d.name);
    if (n === want) return path.join(SUB, d.name);
    if (want.startsWith(n) || n.startsWith(want)) {
      const sc = Math.min(n.length, want.length);
      if (sc > score) { score = sc; best = path.join(SUB, d.name); }
    }
  }
  return best;
}

/** Map excel rows for an author to image files in their folder. */
function pairImages(author, rows) {
  const dir = findPersonDir(author);
  if (!dir) return rows.map((r) => ({ row: r, image: null, reason: 'no folder' }));
  let images = walkImages(dir);

  // Prefer non-archive; already filtered
  // Sort Louise_Photo N / 01 / Photo N naturally
  images.sort((a, b) => {
    const an = path.basename(a);
    const bn = path.basename(b);
    const am = an.match(/(\d+)/);
    const bm = bn.match(/(\d+)/);
    if (am && bm) return parseInt(am[1], 10) - parseInt(bm[1], 10) || an.localeCompare(bn);
    return an.localeCompare(bn);
  });

  // Title-based match when filename contains title words
  const used = new Set();
  const pairs = [];
  for (const row of rows) {
    const title = cleanTitle(row.title);
    const tnorm = norm(title).replace(/\s+/g, '');
    let hit = null;
    // Marcela Anonymous II/III — match numeral in filename first (avoid "Anonymous" hitting I)
    if (/anonymous\s+iii\b/i.test(title)) {
      hit = images.find((img) => !used.has(img) && /anonymous\s*iii\b/i.test(path.basename(img)));
    } else if (/anonymous\s+ii\b/i.test(title)) {
      hit = images.find((img) => !used.has(img) && /anonymous\s*ii(?!i)\b/i.test(path.basename(img)));
    }
    // Yikai bulk-headed 01
    if (!hit && /bulk[\s\-]*headed[\s\-]*0*1\b/i.test(title)) {
      hit = images.find((img) => !used.has(img) && /0*1\b/.test(path.basename(img)) && /bulk|headed/i.test(path.basename(img)));
    }
    if (!hit) {
      hit = images.find((img) => {
        if (used.has(img)) return false;
        const base = path.basename(img, path.extname(img)).toLowerCase().replace(/[\s_\-]+/g, '');
        // require a reasonably specific overlap (not just "anonymous")
        const needle = tnorm.replace(/^anonymous/, '');
        if (needle.length >= 6) return base.includes(needle.slice(0, 12)) || needle.includes(base.slice(0, 12));
        return base.includes(tnorm) && tnorm.length >= 8;
      });
    }
    pairs.push({ row, image: hit || null, reason: hit ? null : 'pending-order' });
    if (hit) used.add(hit);
  }

  // Fill remaining by order among unused images
  const free = images.filter((i) => !used.has(i));
  let fi = 0;
  for (const p of pairs) {
    if (p.image) continue;
    if (fi < free.length) {
      p.image = free[fi++];
      p.reason = null;
    } else {
      p.reason = 'no image';
    }
  }
  return pairs;
}

async function loadImageInput(file) {
  const ext = path.extname(file).toLowerCase();
  if (!HEIC_EXT.has(ext)) return file;
  const input = await fs.promises.readFile(file);
  const jpeg = await heicConvert({ buffer: input, format: 'JPEG', quality: 0.92 });
  return Buffer.from(jpeg);
}

async function prepareImage(file) {
  const maxBytes = 4.5 * 1024 * 1024;
  const input = await loadImageInput(file);
  const targetW = 1280, targetH = 1600;
  let quality = 88;
  let buf = await sharp(input, { failOn: 'none' }).rotate().resize({
    width: targetW, height: targetH, fit: 'cover', position: 'centre',
  }).jpeg({ quality, mozjpeg: true }).toBuffer();
  while (buf.length > maxBytes && quality > 55) {
    quality -= 8;
    buf = await sharp(input, { failOn: 'none' }).rotate().resize({
      width: targetW, height: targetH, fit: 'cover', position: 'centre',
    }).jpeg({ quality, mozjpeg: true }).toBuffer();
  }
  if (buf.length > maxBytes) {
    buf = await sharp(input, { failOn: 'none' }).rotate().resize({
      width: 960, height: 1200, fit: 'cover', position: 'centre',
    }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
  }
  return {
    base64: buf.toString('base64'),
    contentType: 'image/jpeg',
    filename: path.basename(file, path.extname(file)).replace(/[^\w.\-]+/g, '_').slice(0, 60) + '.jpg',
    outBytes: buf.length,
    sourceBytes: fs.statSync(file).size,
  };
}

async function ensureSubmitter(name, submitters) {
  const existing = submitters.find((s) => norm(s.name) === norm(name));
  if (existing) return existing;
  console.log(`  create submitter: ${name}`);
  if (!APPLY) return { id: 'dry-run', name };
  const created = await at(T.submitters, {
    method: 'POST',
    body: JSON.stringify({ fields: { [F.submitterName]: name } }),
  });
  const rec = { id: created.id, name };
  submitters.push(rec);
  return rec;
}

(async () => {
  if (!fs.existsSync(XLSX)) {
    console.error('Excel not found:', XLSX);
    process.exit(1);
  }
  const excel = readExcel(XLSX);
  let [photos, submitters] = await Promise.all([getPhotos(), getSubmitters()]);
  console.log(`Excel: ${excel.length}  Airtable: ${photos.length}  mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`File: ${XLSX}\n`);

  const byKey = new Map();
  for (const p of photos) byKey.set(titleKey(p.submitter, p.title), p);

  // --- 1) Blurb/title updates for matched rows ---
  const updates = [];
  const missing = [];
  for (const row of excel) {
    const title = cleanTitle(row.title);
    const author = soft(row.author);
    const key = titleKey(author, title);
    const photo = byKey.get(key);
    if (!photo) {
      missing.push({ ...row, title });
      continue;
    }
    const fields = {};
    if (title && soft(title) !== soft(photo.title)) fields[F.title] = title.slice(0, 120);
    const excelBlurb = blurbCore(row.blurb);
    const airBlurb = blurbCore(photo.blurb);
    // Prefer excel cleaned blurb when different (including filling empty)
    if (excelBlurb !== airBlurb && (excelBlurb || !airBlurb)) {
      fields[F.blurb] = soft(row.blurb).slice(0, 5000);
    }
    if (Object.keys(fields).length) {
      updates.push({ photo, fields, title, author, excelBlurb: excelBlurb.slice(0, 60) });
    }
  }
  // Dedupe by photo id (excel can list the same shot more than once)
  {
    const seen = new Set();
    for (let i = updates.length - 1; i >= 0; i--) {
      if (seen.has(updates[i].photo.id)) updates.splice(i, 1);
      else seen.add(updates[i].photo.id);
    }
  }

  console.log(`Matched updates (title/blurb): ${updates.length}`);
  for (const u of updates.slice(0, 25)) {
    const bits = [];
    if (u.fields[F.title]) bits.push(`title→${JSON.stringify(u.fields[F.title])}`);
    if (u.fields[F.blurb] != null) bits.push(`blurb→${JSON.stringify(u.excelBlurb)}…`);
    console.log(`  #${u.photo.number} ${u.author}: ${bits.join(' · ')}`);
  }
  if (updates.length > 25) console.log(`  … +${updates.length - 25} more`);

  // --- 2) Missing excel rows → upload ---
  console.log(`\nMissing from Airtable (to upload): ${missing.length}`);
  const byAuthor = new Map();
  for (const row of missing) {
    (byAuthor.get(row.author) || byAuthor.set(row.author, []).get(row.author)).push(row);
  }
  const uploads = [];
  for (const [author, rows] of byAuthor) {
    const pairs = pairImages(author, rows);
    for (const p of pairs) {
      console.log(`  ${author} | ${p.row.title}`);
      console.log(`    image: ${p.image ? path.relative(SUB, p.image) : `(${p.reason})`}`);
      if (p.image) uploads.push({ author, row: p.row, image: p.image });
    }
  }

  // --- 3) Dupes to remove ---
  const doomed = [];
  // Ben: two identical titles — keep lowest number
  const benDup = photos
    .filter((p) => /ben stokoe/i.test(p.submitter) && norm(p.title).includes('transition from powered'))
    .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
  if (benDup.length > 1) {
    for (const p of benDup.slice(1)) {
      doomed.push({ reason: 'Ben Stokoe duplicate title', photo: p });
    }
  }
  // Yikai: two Bulk-headed 02 — keep one; Excel wants 01+02
  const yikai02 = photos
    .filter((p) => /yikai/i.test(p.submitter) && /bulk[\s\-]*headed[\s\-]*0*2\b/i.test(p.title))
    .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
  if (yikai02.length > 1) {
    for (const p of yikai02.slice(1)) {
      doomed.push({ reason: 'Yikai Chang duplicate Bulk-headed 02', photo: p });
    }
  }

  console.log(`\nDuplicates to delete: ${doomed.length}`);
  for (const d of doomed) {
    console.log(`  #${d.photo.number} ${d.photo.submitter} | ${d.photo.title}  (${d.reason})`);
  }

  // Airtable-only not in excel (informational)
  const excelKeys = new Set(excel.map((r) => titleKey(r.author, r.title)));
  const onlyAir = photos.filter((p) => !excelKeys.has(titleKey(p.submitter, p.title))
    && !doomed.some((d) => d.photo.id === p.id));
  // After Ben keep one, the kept Ben title is in excel? Excel missing one Ben transition - so one Ben will remain onlyAir if excel has 0 or 1
  console.log(`\nAirtable-only after plan (excl. doomed): ${onlyAir.length}`);
  for (const p of onlyAir) console.log(`  #${p.number} ${p.submitter} | ${p.title}`);

  if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply to write Airtable.');
    return;
  }

  // APPLY
  console.log('\n--- Applying ---');
  for (const u of updates) {
    await at(`${T.photos}/${u.photo.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: u.fields }),
    });
    process.stdout.write('.');
  }
  console.log(` updated ${updates.length}`);

  for (const d of doomed) {
    console.log(`delete #${d.photo.number} ${d.photo.title}`);
    await deletePhoto(d.photo.id);
  }

  // Refresh submitters after possible creates
  for (const up of uploads) {
    const sub = await ensureSubmitter(up.author, submitters);
    process.stdout.write(`↑ ${up.author} — ${cleanTitle(up.row.title).slice(0, 40)}… `);
    try {
      const img = await prepareImage(up.image);
      await createPhotoFromUpload({
        title: cleanTitle(up.row.title).slice(0, 120),
        blurb: soft(up.row.blurb),
        submitterId: sub.id,
        contentType: img.contentType,
        file: img.base64,
        filename: img.filename,
      });
      console.log(`ok (${(img.outBytes / 1024).toFixed(0)}KB)`);
      await new Promise((r) => setTimeout(r, 300));
    } catch (e) {
      console.log('FAIL:', e.message);
    }
  }

  console.log('Sorting A–Z…');
  const changes = await renumberPhotosAlpha();
  console.log(`Done. ${changes.length} photos numbered.`);

  const after = await getPhotos();
  console.log(`Airtable now: ${after.length}`);
})().catch((e) => { console.error(e); process.exit(1); });
