/**
 * Mass-import submissions from a folder of per-person packages.
 *
 * Default is a dry-run. Pass --apply to upload into Airtable.
 *
 *   node scripts/mass-import.js
 *   node scripts/mass-import.js --apply
 *   node scripts/mass-import.js --dir "C:\Users\...\Submission" --apply
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');
const heicConvert = require('heic-convert');

const ROOT = path.join(__dirname, '..');
try {
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) return;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  });
} catch {}

const { getSubmitters, getPhotos, createPhotoFromUpload, nextPhotoNumber, renumberPhotosAlpha } = require('../api/_lib/airtable');

const APPLY = process.argv.includes('--apply');
const dirFlag = process.argv.indexOf('--dir');
const onlyFlag = process.argv.indexOf('--only');
const ONLY = onlyFlag >= 0
  ? process.argv[onlyFlag + 1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  : null;
const SUBMISSION_DIR = dirFlag >= 0
  ? process.argv[dirFlag + 1]
  : 'C:\\Users\\RivinduB\\Desktop\\Submission';

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.heic', '.heif']);
const HEIC_EXT = new Set(['.heic', '.heif']);
const SKIP_DIRS = new Set(['_name']);

/** Folder name → Airtable Submitters.Name when they don't match exactly. */
const ALIASES = {
  'gary lo': 'Gary Lo',
  'gosia p': 'Gosia Piotrowski',
  'jess amzallag': 'Jessica Amzallag',
  'julia s': 'Julia Solomon',
  'derek lee': 'Derek Lee Cheuk Man',
};

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('~$') || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function readDocxText(file) {
  const buf = fs.readFileSync(file);
  // Minimal ZIP local-file scan for word/document.xml
  let i = 0;
  while (i < buf.length - 30) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i += 1; continue; }
    const method = buf.readUInt16LE(i + 8);
    const comp = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    if (name === 'word/document.xml') {
      const data = buf.slice(start, start + comp);
      const xml = (method === 0 ? data : zlib.inflateRawSync(data)).toString('utf8');
      return xml
        .replace(/<\/w:p>/g, '\n')
        .replace(/<w:tab[^/]*\/>/g, '\t')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\r/g, '');
    }
    i = start + (comp || 0);
  }
  throw new Error('No word/document.xml in ' + file);
}

function cleanLines(text) {
  return text.split(/\n+/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function isBoilerplate(line) {
  return /^(2026\s+photography\s+exhibition|written\s+submission|please\s+fill|device\(s\)?\s*(used|:)|\S+\s+[–-]\s*photo\s*\d+)/i.test(line)
    || /^device\s*:/i.test(line);
}

function isDeviceLine(line) {
  return /^(device|iphone|ipad|gopro|canon|nikon|sony|fuji|olympus|pixel|samsung|leica|hasselblad|android)/i.test(line)
    || /\b(iphone|gopro|canon eos|nikon|sony a|olympus|pixel)\b/i.test(line) && line.length < 80;
}

function takeAfterLabel(lines, i, labelRe) {
  const same = lines[i].replace(labelRe, '').replace(/^[:\-–\s]+/, '').trim();
  if (same) return { value: same, next: i + 1 };
  if (lines[i + 1] && !isBoilerplate(lines[i + 1])) return { value: lines[i + 1], next: i + 2 };
  return { value: '', next: i + 1 };
}

function cleanTitle(title) {
  return String(title || '')
    .replace(/^2026 Photography Exhibition\s*/i, '')
    .replace(/^title\s*[:\-–]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleKey(submitter, title) {
  return `${String(submitter || '').toLowerCase()}|${cleanTitle(title).toLowerCase()}`;
}

function parseDoc(text) {
  // Compact one-line style: TitleSubject: … Blurb: … Device:
  const compact = text.match(
    /([^\n]{3,120}?)\s*Subject\s*:\s*([\s\S]*?)\s*Blurb\s*:\s*([\s\S]*?)(?:\s*Device\s*:|$)/i,
  );
  if (compact && !/written submission/i.test(compact[1])) {
    return {
      title: cleanTitle(compact[1]),
      subject: compact[2].replace(/\s+/g, ' ').trim(),
      blurb: compact[3].replace(/\s+/g, ' ').trim(),
    };
  }

  const lines = cleanLines(text);
  let title = '', subject = '', blurbParts = [];
  let mode = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBoilerplate(line) && !mode) continue;

    if (/^title\b/i.test(line)) {
      const t = takeAfterLabel(lines, i, /^title\b/i);
      title = t.value.replace(/^title\s*[:\-–]\s*/i, '').trim();
      i = t.next - 1; mode = null; continue;
    }
    if (/^subject\b/i.test(line)) {
      const t = takeAfterLabel(lines, i, /^subject\b/i);
      subject = t.value; i = t.next - 1; mode = null; continue;
    }
    if (/^blurb\b/i.test(line)) {
      let same = line.replace(/^blurb\b/i, '').trim();
      same = same.replace(/^\(.*?\)\s*/i, '').replace(/^[:\-–)\s]+/, '').trim();
      blurbParts = same ? [same] : [];
      mode = 'blurb';
      continue;
    }
    if (/^device\b/i.test(line) || isDeviceLine(line)) {
      mode = null;
      continue;
    }

    if (mode === 'blurb') {
      blurbParts.push(line);
      continue;
    }

    // Unlabeled template (Carol-style): first content = title, second = subject, rest = blurb
    if (!title && !isBoilerplate(line)) { title = line; continue; }
    if (title && !subject && !isBoilerplate(line) && !isDeviceLine(line)) { subject = line; continue; }
    if (title && subject && !isBoilerplate(line) && !isDeviceLine(line)) blurbParts.push(line);
  }

  let blurb = blurbParts.join(' ').replace(/\s+/g, ' ').trim().replace(/^\)\s*/, '');
  title = cleanTitle(title);
  // Reject unfilled template leftovers
  if (/^(title|subject(\s*\(.*\))?)$/i.test(title)) title = '';
  if (/^(blurb|subject(\s*\(.*\))?)$/i.test(blurb)) blurb = '';
  return { title, subject: subject.trim(), blurb };
}

function isImage(file) {
  return IMG_EXT.has(path.extname(file).toLowerCase());
}

function isDoc(file) {
  return path.extname(file).toLowerCase() === '.docx' && !path.basename(file).startsWith('~$');
}

function isTxt(file) {
  return path.extname(file).toLowerCase() === '.txt';
}

function titleFromImageName(file) {
  let base = path.basename(file, path.extname(file));
  // "defense. - iPhone 17 Pro" → "defense."
  base = base.replace(/\s*[-–—]\s*(iphone|ipad|gopro|canon|nikon|sony|pixel|samsung|device).*$/i, '').trim();
  base = base.replace(/\s*[-–—]\s*blurb$/i, '').trim();
  return base.replace(/[._]+$/g, '').trim() || base.trim();
}

/** Serena-style: one doc listing Photo 1…N titles/blurbs. */
function parseMultiPhotoDoc(text) {
  const titles = {}, subjects = {}, blurbs = {};
  const lines = cleanLines(text);
  let mode = null;
  for (const line of lines) {
    if (/^title\b/i.test(line)) { mode = 'title'; continue; }
    if (/^subject\b/i.test(line)) { mode = 'subject'; continue; }
    if (/^blurb\b/i.test(line)) { mode = 'blurb'; continue; }
    if (/^device\b/i.test(line) || isDeviceLine(line) || isBoilerplate(line)) { mode = null; continue; }
    const m = line.match(/^photo\s*(\d+)\s*[:.\-–]\s*(.+)$/i);
    if (!m || !mode) continue;
    const n = m[1];
    const val = m[2].trim();
    if (mode === 'title') titles[n] = val;
    else if (mode === 'subject') subjects[n] = val;
    else if (mode === 'blurb') blurbs[n] = (blurbs[n] ? blurbs[n] + ' ' : '') + val;
  }
  return { titles, subjects, blurbs };
}

function scoreNameMatch(folder, submitterName) {
  const a = folder.toLowerCase().trim();
  const b = submitterName.toLowerCase().trim();
  if (a === b) return 100;
  if (ALIASES[a] && ALIASES[a].toLowerCase() === b) return 95;
  if (b.startsWith(a) || a.startsWith(b)) return 80;
  const at = a.split(/\s+/), bt = b.split(/\s+/);
  if (at[0] === bt[0] && at.length > 1 && bt[bt.length - 1].startsWith(at[at.length - 1][0])) return 70;
  if (at[0] === bt[0]) return 50;
  return 0;
}

function matchSubmitter(folderName, submitters) {
  let best = null, score = 0;
  for (const s of submitters) {
    const sc = scoreNameMatch(folderName, s.name);
    if (sc > score) { score = sc; best = s; }
  }
  return score >= 50 ? { ...best, score } : null;
}

/** Pair images with docs/txt in the same folder; also handle multi-photo root docs. */
function pairEntries(personDir) {
  // Skip Archive / _Archive / .trash style folders so retired takes don't re-import
  const files = walk(personDir).filter((f) => !/[\\/]_?archive[\\/]/i.test(f) && !/[\\/]\./.test(f.replace(personDir, '')));
  const docs = files.filter(isDoc);
  const images = files.filter(isImage);
  const txts = files.filter(isTxt);
  const used = new Set();
  const pairs = [];

  // Root multi-photo written submission (Serena)
  const rootDocs = docs.filter((d) => path.dirname(d) === personDir);
  let multi = null;
  for (const rd of rootDocs) {
    try {
      const parsed = parseMultiPhotoDoc(readDocxText(rd));
      if (Object.keys(parsed.titles).length >= 2) { multi = { doc: rd, ...parsed }; break; }
    } catch { /* ignore */ }
  }
  if (multi) {
    for (const img of images) {
      const folder = path.basename(path.dirname(img));
      const m = folder.match(/photo\s*(\d+)/i);
      if (!m) continue;
      const n = String(parseInt(m[1], 10));
      const title = multi.titles[n];
      const blurb = multi.blurbs[n] || '';
      if (!title) continue;
      used.add(img);
      pairs.push({
        doc: multi.doc, image: img,
        parsed: { title, subject: multi.subjects[n] || '', blurb },
        error: blurb ? null : 'Could not parse blurb',
      });
    }
  }

  // Group remaining by directory
  const byDir = new Map();
  for (const doc of docs) {
    if (multi && doc === multi.doc) continue;
    const dir = path.dirname(doc);
    if (!byDir.has(dir)) byDir.set(dir, { docs: [], images: [], txts: [] });
    byDir.get(dir).docs.push(doc);
  }
  for (const img of images) {
    if (used.has(img)) continue;
    const dir = path.dirname(img);
    if (!byDir.has(dir)) byDir.set(dir, { docs: [], images: [], txts: [] });
    byDir.get(dir).images.push(img);
  }
  for (const t of txts) {
    const dir = path.dirname(t);
    if (!byDir.has(dir)) byDir.set(dir, { docs: [], images: [], txts: [] });
    byDir.get(dir).txts.push(t);
  }

  for (const [, group] of byDir) {
    const imgs = group.images.slice().sort((a, b) => a.localeCompare(b));
    const docList = group.docs.slice().sort((a, b) => a.localeCompare(b));

    for (const doc of docList) {
      const free = imgs.filter((i) => !used.has(i));
      if (!free.length) {
        pairs.push({ doc, image: null, parsed: null, error: 'No image found for doc' });
        continue;
      }
      const base = path.basename(doc, '.docx').toLowerCase().replace(/[\s_\-]+/g, '');
      free.sort((a, b) => {
        const ab = path.basename(a, path.extname(a)).toLowerCase().replace(/[\s_\-]+/g, '');
        const bb = path.basename(b, path.extname(b)).toLowerCase().replace(/[\s_\-]+/g, '');
        const as = ab.includes(base) || base.includes(ab) ? 1 : 0;
        const bs = bb.includes(base) || base.includes(bb) ? 1 : 0;
        return bs - as || a.localeCompare(b);
      });
      const img = free[0];
      used.add(img);
      try {
        const parsed = parseDoc(readDocxText(doc));
        let error = null;
        if (!parsed.title) error = 'Could not parse title';
        else if (!parsed.blurb) error = 'Could not parse blurb';
        pairs.push({ doc, image: img, parsed, error });
      } catch (e) {
        pairs.push({ doc, image: img, parsed: null, error: e.message });
      }
    }

    // Remaining images + .txt blurbs (Rivindu-style)
    for (const img of imgs.filter((i) => !used.has(i))) {
      const imgBase = path.basename(img, path.extname(img)).toLowerCase();
      let txt = group.txts.find((t) => {
        const tb = path.basename(t, '.txt').toLowerCase();
        return imgBase.includes(tb.replace(/\s*-\s*blurb$/, '')) || tb.includes(imgBase.split(/\s*-\s*/)[0]);
      }) || (group.txts.length === 1 ? group.txts[0] : null);
      if (!txt && !docList.length) {
        // image-only folder with no text — skip (can't invent blurb)
        continue;
      }
      if (!txt) continue;
      const blurb = fs.readFileSync(txt, 'utf8').replace(/\s+/g, ' ').trim();
      const title = titleFromImageName(img);
      used.add(img);
      pairs.push({
        doc: txt, image: img,
        parsed: { title, subject: '', blurb },
        error: title && blurb ? null : 'Could not parse title/blurb from txt',
      });
    }
  }

  return pairs;
}

/** Sharp’s prebuilt Windows binaries can’t decode HEVC HEIC — convert first. */
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
  const meta = await sharp(input, { failOn: 'none' }).metadata();
  // Fit into 4:5 cover crop, max edge 1600
  const targetW = 1280, targetH = 1600;
  let quality = 88;
  let buf = await sharp(input, { failOn: 'none' }).rotate().resize({
    width: targetW,
    height: targetH,
    fit: 'cover',
    position: 'centre',
  }).jpeg({ quality, mozjpeg: true }).toBuffer();

  while (buf.length > maxBytes && quality > 55) {
    quality -= 8;
    buf = await sharp(input, { failOn: 'none' }).rotate().resize({
      width: targetW, height: targetH, fit: 'cover', position: 'centre',
    }).jpeg({ quality, mozjpeg: true }).toBuffer();
  }
  if (buf.length > maxBytes) {
    // shrink further
    buf = await sharp(input, { failOn: 'none' }).rotate().resize({
      width: 960, height: 1200, fit: 'cover', position: 'centre',
    }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
  }
  return {
    buffer: buf,
    base64: buf.toString('base64'),
    contentType: 'image/jpeg',
    filename: path.basename(file, path.extname(file)).replace(/[^\w.\-]+/g, '_').slice(0, 60) + '.jpg',
    sourceBytes: fs.statSync(file).size,
    outBytes: buf.length,
    source: `${meta.width || '?'}x${meta.height || '?'}`,
  };
}

async function main() {
  if (!fs.existsSync(SUBMISSION_DIR)) {
    console.error('Submission folder not found:', SUBMISSION_DIR);
    process.exit(1);
  }
  if (!process.env.AIRTABLE_TOKEN) {
    console.error('AIRTABLE_TOKEN missing in .env');
    process.exit(1);
  }

  const [submitters, existing] = await Promise.all([getSubmitters(), getPhotos()]);
  const existingKeys = new Set(existing.map((p) => titleKey(p.submitter, p.title)));

  const people = fs.readdirSync(SUBMISSION_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name.toLowerCase()))
    .map((d) => d.name)
    .filter((n) => !ONLY || ONLY.some((o) => n.toLowerCase().includes(o) || o.includes(n.toLowerCase())))
    .sort((a, b) => a.localeCompare(b));

  const plan = [];
  const unmatched = [];

  for (const person of people) {
    const sub = matchSubmitter(person, submitters);
    if (!sub) {
      unmatched.push(person);
      continue;
    }
    const pairs = pairEntries(path.join(SUBMISSION_DIR, person));
    for (const p of pairs) {
      const title = cleanTitle(p.parsed?.title || '');
      const dup = title && existingKeys.has(titleKey(sub.name, title));
      plan.push({
        folder: person,
        submitterId: sub.id,
        submitterName: sub.name,
        matchScore: sub.score,
        doc: p.doc,
        image: p.image,
        title,
        blurb: p.parsed?.blurb || '',
        subject: p.parsed?.subject || '',
        error: dup ? 'Already in Airtable (skip)' : p.error,
        skip: !!dup,
      });
    }
  }

  console.log(`Found ${people.length} people folders · ${plan.length} photo packages · mode=${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

  if (unmatched.length) {
    console.log('UNMATCHED folders (no Airtable submitter):');
    unmatched.forEach((n) => console.log('  -', n));
    console.log('');
  }

  const ok = plan.filter((p) => p.image && p.title && !p.error && !p.skip);
  const skipped = plan.filter((p) => p.skip);
  const bad = plan.filter((p) => !ok.includes(p) && !p.skip);

  console.log(`Ready: ${ok.length}  ·  Already uploaded: ${skipped.length}  ·  Needs attention: ${bad.length}\n`);
  for (const p of bad) {
    console.log(`! ${p.folder}`);
    console.log(`    doc: ${p.doc ? path.relative(SUBMISSION_DIR, p.doc) : '(none)'}`);
    console.log(`    img: ${p.image ? path.relative(SUBMISSION_DIR, p.image) : '(none)'}`);
    console.log(`    err: ${p.error || 'missing title'}`);
  }

  console.log('\n--- Preview (first 12 ready) ---');
  ok.slice(0, 12).forEach((p, i) => {
    console.log(`${i + 1}. ${p.submitterName}  |  ${p.title}`);
    console.log(`   blurb: ${(p.blurb || '').slice(0, 110)}${(p.blurb || '').length > 110 ? '…' : ''}`);
    console.log(`   file:  ${path.relative(SUBMISSION_DIR, p.image)}`);
  });

  // Write full report
  const reportPath = path.join(ROOT, 'scripts', 'mass-import-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ unmatched, plan }, null, 2));
  console.log(`\nFull report: ${reportPath}`);

  if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply to upload.');
    return;
  }

  let number = await nextPhotoNumber();
  let n = parseInt(number, 10) || 1;
  let uploaded = 0, failed = 0;

  for (const p of ok) {
    const num = String(n).padStart(3, '0');
    process.stdout.write(`↑ ${num} ${p.submitterName} — ${p.title.slice(0, 40)}… `);
    try {
      const img = await prepareImage(p.image);
      await createPhotoFromUpload({
        title: p.title.slice(0, 120),
        blurb: p.blurb,
        number: num,
        submitterId: p.submitterId,
        contentType: img.contentType,
        file: img.base64,
        filename: img.filename,
      });
      console.log(`ok (${(img.outBytes / 1024).toFixed(0)}KB from ${(img.sourceBytes / 1024 / 1024).toFixed(1)}MB)`);
      uploaded += 1;
      n += 1;
      await new Promise((r) => setTimeout(r, 300));
    } catch (e) {
      console.log('FAIL:', e.message);
      failed += 1;
    }
  }

  console.log(`\nDone. uploaded=${uploaded} failed=${failed}`);
  if (uploaded > 0) {
    process.stdout.write('Sorting gallery A–Z by author… ');
    const changes = await renumberPhotosAlpha();
    console.log(`done (${changes.length} photos).`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
