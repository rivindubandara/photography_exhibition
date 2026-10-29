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

const { renumberPhotos, getPhotos } = require('../api/_lib/airtable');

(async () => {
  const before = await getPhotos();
  console.log(`Renumbering ${before.length} photos…`);
  const changes = await renumberPhotos();
  if (!changes.length) console.log('Already sequential — nothing to change.');
  else changes.forEach((c) => console.log(`  ${c.from || '(blank)'} → ${c.to}  ${c.title}`));
  const after = await getPhotos();
  console.log('Now:', after.map((p) => p.number).join(', '));
})().catch((e) => { console.error(e); process.exit(1); });
