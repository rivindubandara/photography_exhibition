/**
 * Import remaining awkward packages (txt/odt/image-only), then
 * renumber all photos A–Z by submitter (grouped).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');

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

const {
  getSubmitters, getPhotos, createPhotoFromUpload, nextPhotoNumber, renumberPhotosAlpha, F, T, at,
} = require('../api/_lib/airtable');

const SUB = 'C:\\Users\\RivinduB\\Desktop\\Submission';
const APPLY = process.argv.includes('--apply');

async function prepareImage(file) {
  const maxBytes = 4.5 * 1024 * 1024;
  const targetW = 1280, targetH = 1600;
  let quality = 88;
  let buf = await sharp(file, { failOn: 'none' }).rotate().resize({
    width: targetW, height: targetH, fit: 'cover', position: 'centre',
  }).jpeg({ quality, mozjpeg: true }).toBuffer();
  while (buf.length > maxBytes && quality > 55) {
    quality -= 8;
    buf = await sharp(file, { failOn: 'none' }).rotate().resize({
      width: targetW, height: targetH, fit: 'cover', position: 'centre',
    }).jpeg({ quality, mozjpeg: true }).toBuffer();
  }
  if (buf.length > maxBytes) {
    buf = await sharp(file, { failOn: 'none' }).rotate().resize({
      width: 960, height: 1200, fit: 'cover', position: 'centre',
    }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
  }
  return {
    base64: buf.toString('base64'),
    contentType: 'image/jpeg',
    filename: path.basename(file, path.extname(file)).replace(/[^\w.\-]+/g, '_').slice(0, 60) + '.jpg',
    outBytes: buf.length,
  };
}

function readOdtText(file) {
  const buf = fs.readFileSync(file);
  let i = 0;
  while (i < buf.length - 30) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i += 1; continue; }
    const method = buf.readUInt16LE(i + 8);
    const comp = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    if (name === 'content.xml') {
      const data = buf.slice(start, start + comp);
      const xml = (method === 0 ? data : zlib.inflateRawSync(data)).toString('utf8');
      return xml
        .replace(/<\/text:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\u00a0/g, ' ');
    }
    i = start + (comp || 0);
  }
  throw new Error('No content.xml');
}

function parseParmdeep(text) {
  const lines = text.split(/\n+/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .filter((l) => !/^taken with/i.test(l));
  // Photo 1 & 2 / Photo 3- / Photo 4-
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const head = line.match(/^photo\s*(\d+)(?:\s*&\s*(\d+))?\s*[-–—:]?\s*(.*)$/i);
    if (head) {
      if (cur) blocks.push(cur);
      const nums = head[2] ? [head[1], head[2]] : [head[1]];
      cur = { nums, title: (head[3] || '').replace(/^threshold[-\s]*/i, 'Threshold — ').trim() || `Photo ${nums.join(' & ')}`, blurbs: [] };
      continue;
    }
    if (cur) cur.blurbs.push(line);
  }
  if (cur) blocks.push(cur);

  // Expand: block with nums [1,2] and 2 blurb paragraphs → assign one each
  const byNum = {};
  for (const b of blocks) {
    const textBlurb = b.blurbs.join(' ').trim();
    if (b.nums.length === 2 && b.blurbs.length >= 2) {
      byNum[b.nums[0]] = { title: b.title, blurb: b.blurbs[0] };
      byNum[b.nums[1]] = { title: b.title, blurb: b.blurbs[1] };
    } else {
      for (const n of b.nums) byNum[n] = { title: b.title.replace(/^Threshold — /, '') || b.title, blurb: textBlurb };
    }
  }
  // Prefer titled forms
  if (byNum['1']) byNum['1'].title = 'Threshold — Atmosphere';
  if (byNum['2']) byNum['2'].title = 'Threshold — Atmosphere';
  if (byNum['3']) byNum['3'].title = 'Threshold — Intersection';
  if (byNum['4']) byNum['4'].title = 'Threshold — Repetition';
  return byNum;
}

function findSubmitter(submitters, name) {
  const n = name.toLowerCase();
  return submitters.find((s) => s.name.toLowerCase() === n)
    || submitters.find((s) => s.name.toLowerCase().startsWith(n) || n.startsWith(s.name.toLowerCase()));
}

async function main() {
  const submitters = await getSubmitters();
  const existing = await getPhotos();
  const existingKeys = new Set(existing.map((p) => `${(p.submitter || '').toLowerCase()}|${(p.title || '').toLowerCase()}`));

  const plan = [];

  // Dilhan — single image, no blurb
  {
    const sub = findSubmitter(submitters, 'Dilhan Ali');
    const img = path.join(SUB, 'Dilhan Ali', 'Between Two Buildings.jpg');
    if (sub && fs.existsSync(img)) {
      const title = 'Between Two Buildings';
      const key = `${sub.name.toLowerCase()}|${title.toLowerCase()}`;
      if (!existingKeys.has(key)) {
        plan.push({ submitterId: sub.id, submitterName: sub.name, title, blurb: '', image: img });
      }
    }
  }

  // Parmdeep — ODT + photos in Photo 1/3/4 folders
  {
    const sub = findSubmitter(submitters, 'Parmdeep Thandi');
    const odt = path.join(SUB, 'Parmdeep Thandi', 'Blurbs Photos.odt');
    if (sub && fs.existsSync(odt)) {
      const byNum = parseParmdeep(readOdtText(odt));
      const map = {
        1: path.join(SUB, 'Parmdeep Thandi', 'Photo 1', 'Parmdeep Thandi_Photo 1.jpeg'),
        2: path.join(SUB, 'Parmdeep Thandi', 'Photo 1', 'Parmdeep Thandi_Photo 2.Jpeg'),
        3: path.join(SUB, 'Parmdeep Thandi', 'Photo 3', 'Parmdeep Thandi Photo 3.jpeg'),
        4: path.join(SUB, 'Parmdeep Thandi', 'Photo 4', 'Photo 4.jpeg'),
      };
      for (const [n, img] of Object.entries(map)) {
        if (!fs.existsSync(img) || !byNum[n]) continue;
        const title = byNum[n].title;
        const key = `${sub.name.toLowerCase()}|${title.toLowerCase()}`;
        // Photo 1 & 2 share title — allow second with " (2)" if needed
        let finalTitle = title;
        if (existingKeys.has(key) || plan.some((p) => p.submitterName === sub.name && p.title === finalTitle)) {
          finalTitle = `${title} (${n})`;
        }
        plan.push({
          submitterId: sub.id, submitterName: sub.name,
          title: finalTitle, blurb: byNum[n].blurb, image: img,
        });
      }
    }
  }

  console.log(`Remaining packages: ${plan.length}  mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  plan.forEach((p, i) => {
    console.log(`${i + 1}. ${p.submitterName} | ${p.title}`);
    console.log(`   ${(p.blurb || '(no blurb)').slice(0, 100)}`);
  });

  if (!APPLY) {
    console.log('\nRe-run with --apply to upload + alphabetical renumber.');
    return;
  }

  let n = parseInt(await nextPhotoNumber(), 10) || 1;
  for (const p of plan) {
    const num = String(n).padStart(3, '0');
    process.stdout.write(`↑ ${num} ${p.submitterName} — ${p.title}… `);
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
      console.log('ok');
      n += 1;
      await new Promise((r) => setTimeout(r, 300));
    } catch (e) {
      console.log('FAIL', e.message);
    }
  }

  console.log('\nRenumbering A–Z by author…');
  const changes = await renumberPhotosAlpha();
  console.log(`Updated ${changes.length} photo numbers.`);
  const after = await getPhotos();
  let last = '';
  for (const p of after) {
    if (p.submitter !== last) {
      console.log(`\n${p.submitter || '(no submitter)'}`);
      last = p.submitter;
    }
    console.log(`  ${p.number}  ${p.title}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
