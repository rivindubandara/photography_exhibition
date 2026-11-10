/**
 * Upload multi-image sets that share a title (Nash trio, Gosia pair, Ben pair).
 *   node scripts/upload-sets.js --apply
 */
const fs = require('fs');
const path = require('path');
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
  getPhotos, getSubmitters, createPhotoFromUpload, renumberPhotosAlpha,
} = require('../api/_lib/airtable');

const APPLY = process.argv.includes('--apply');
const SUB = 'C:\\Users\\RivinduB\\Desktop\\Submission';
const HEIC = new Set(['.heic', '.heif']);

async function loadInput(file) {
  const ext = path.extname(file).toLowerCase();
  if (!HEIC.has(ext)) return file;
  const jpeg = await heicConvert({
    buffer: await fs.promises.readFile(file),
    format: 'JPEG',
    quality: 0.92,
  });
  return Buffer.from(jpeg);
}

async function prepareImage(file) {
  const maxBytes = 4.5 * 1024 * 1024;
  const input = await loadInput(file);
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

function findSubmitter(submitters, name) {
  const n = name.toLowerCase();
  return submitters.find((s) => s.name.toLowerCase() === n)
    || submitters.find((s) => s.name.toLowerCase().startsWith(n) || n.startsWith(s.name.toLowerCase().split(' ')[0]));
}

const JOBS = [
  // Nash — Photo 2 set: 2-1 already uploaded; add 2-2 and 2-3
  {
    author: 'Nash Gonzalvez',
    title: 'Some Lines Are Straighter Than Others',
    blurb: 'Shot straight down from the air, each photograph is cut in two by the edge where land meets water, but each edge is drawn differently: some lines are straighter than others.',
    // blurb will be overwritten from existing Airtable record if present
    images: [
      path.join(SUB, 'Nash Gonzalvez', 'Photo 2', 'Nash - photo 2-2.JPG'),
      path.join(SUB, 'Nash Gonzalvez', 'Photo 2', 'Nash - photo 2-3.JPG'),
    ],
    existingTitle: /some lines are straighter/i,
  },
  // Gosia — Photo 2
  {
    author: 'Gosia Piotrowski',
    title: 'A quarter century reflection on self-portraiture.',
    blurb: "Looking at these photos side by side allows us to stand on the dividing line of a paradigm shift. It marks a threshold where photography ceased to be just a tool for preserving the past, it became a tool for broadcasting the present. We have transitioned from using cameras to deliberately look at the world, to using cameras to construct how the world looks at us.",
    images: [
      path.join(SUB, 'Gosia P', 'Photo 2.JPEG'),
    ],
    existingTitle: /quarter century reflection/i,
  },
  // Ben — Photo 2 (same title as Photo 1; Photo 3 already up)
  {
    author: 'Ben Stokoe',
    title: 'The transition from powered to human flight',
    blurb: 'This threshold is the transition between claustrophobia and pure weightless freedom. From the cramped and over crowded aircraft to the big blue sky and freedom of human flight.',
    images: [
      path.join(SUB, 'Ben Stokoe', 'Photo 2', 'Ben Stokoe - Photo 2 005.jpg'),
    ],
    existingTitle: /transition from powered/i,
  },
];

(async () => {
  const [photos, submitters] = await Promise.all([getPhotos(), getSubmitters()]);
  console.log(`mode=${APPLY ? 'APPLY' : 'DRY-RUN'}  airtable=${photos.length}`);

  const plan = [];
  for (const job of JOBS) {
    const sub = findSubmitter(submitters, job.author);
    if (!sub) {
      console.log(`! No submitter for ${job.author}`);
      continue;
    }
    const existing = photos.filter((p) => p.submitter === sub.name && job.existingTitle.test(p.title || ''));
    const blurb = existing[0]?.blurb || job.blurb;
    console.log(`\n${job.author} | ${job.title}`);
    console.log(`  already on site: ${existing.length}`);
    for (const img of job.images) {
      const ok = fs.existsSync(img);
      console.log(`  upload: ${ok ? path.relative(SUB, img) : 'MISSING ' + img}`);
      if (ok) plan.push({ submitterId: sub.id, author: sub.name, title: job.title, blurb, image: img });
    }
  }

  console.log(`\nPlanned uploads: ${plan.length}`);
  if (!APPLY) {
    console.log('Dry-run only. Re-run with --apply.');
    return;
  }

  for (const p of plan) {
    process.stdout.write(`↑ ${p.author} — ${path.basename(p.image)}… `);
    try {
      const img = await prepareImage(p.image);
      await createPhotoFromUpload({
        title: p.title.slice(0, 120),
        blurb: p.blurb,
        submitterId: p.submitterId,
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
  const after = await getPhotos();
  console.log(`Done. ${changes.length} photos.`);
  for (const name of [/nash/i, /gosia/i, /ben stokoe/i]) {
    const list = after.filter((p) => name.test(p.submitter || ''));
    console.log(`\n${list[0]?.submitter}: ${list.length}`);
    for (const p of list) console.log(`  ${p.number}  ${p.title}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
