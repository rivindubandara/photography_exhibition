const fs = require('fs');
const path = require('path');
try {
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) return;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  });
} catch {}

const { renumberPhotosAlpha, getPhotos } = require('../api/_lib/airtable');

(async () => {
  const before = await getPhotos();
  console.log(`Renumbering ${before.length} photos A–Z by author…`);
  const changes = await renumberPhotosAlpha();
  console.log(`Assigned ${changes.length} numbers.`);
  const after = await getPhotos();
  let last = '';
  for (const p of after) {
    if (p.submitter !== last) {
      console.log(`\n${p.submitter || '(none)'}`);
      last = p.submitter;
    }
    console.log(`  ${p.number}  ${p.title}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
