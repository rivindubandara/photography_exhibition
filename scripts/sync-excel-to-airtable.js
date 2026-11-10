/**
 * Push Title + Blurb from the catalogue Excel into Airtable where they differ.
 * Match primarily by Photo ID (Submission ID); fall back to author+title.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

try {
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) return;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  });
} catch {}

const { getPhotos, at, T, F } = require('../api/_lib/airtable');

const XLSX = path.join(__dirname, '..', 'NT Photography Exhibition 2026 — Submissions.xlsx');
const APPLY = process.argv.includes('--apply');

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^title\s*[:\-–]\s*/i, '')
    .replace(/[^\w\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readExcelRows() {
  const py = `
from openpyxl import load_workbook
import json
wb = load_workbook(r'''${XLSX.replace(/\\/g, '\\\\')}''', data_only=True)
ws = wb.active
headers = [ws.cell(1, c).value for c in range(1, ws.max_column + 1)]
# Support both layouts
def idx(*names):
  for n in names:
    if n in headers: return headers.index(n) + 1
  return None
c_id = idx('Submission ID')
c_title = idx('Title')
c_blurb = idx('Blurb')
c_author = idx('Author')
c_subject = idx('Subject')
c_device = idx('Device')
rows = []
for r in range(2, ws.max_row + 1):
  rows.append({
    'number': str(ws.cell(r, c_id).value or '').strip().zfill(3) if str(ws.cell(r, c_id).value or '').strip().isdigit() else str(ws.cell(r, c_id).value or '').strip(),
    'title': (ws.cell(r, c_title).value or '').strip() if c_title else '',
    'blurb': (ws.cell(r, c_blurb).value or '').strip() if c_blurb else '',
    'author': (ws.cell(r, c_author).value or '').strip() if c_author else '',
    'subject': (ws.cell(r, c_subject).value or '').strip() if c_subject else '',
    'device': (ws.cell(r, c_device).value or '').strip() if c_device else '',
  })
print(json.dumps(rows))
`;
  const out = execFileSync('python', ['-c', py], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(out);
}

(async () => {
  const excel = readExcelRows();
  const photos = await getPhotos();
  console.log(`Excel: ${excel.length}  Airtable: ${photos.length}  mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const byNum = new Map(photos.map((p) => [String(p.number).padStart(3, '0'), p]));
  const byAuthorTitle = new Map();
  for (const p of photos) {
    byAuthorTitle.set(`${norm(p.submitter)}|${norm(p.title)}`, p);
  }

  const updates = [];
  const unmatched = [];

  for (const row of excel) {
    const num = String(row.number || '').replace(/\D/g, '').padStart(3, '0');
    let photo = byNum.get(num);
    if (!photo || norm(photo.submitter) !== norm(row.author)) {
      // ID may have shifted — prefer author+title
      photo = byAuthorTitle.get(`${norm(row.author)}|${norm(row.title)}`) || photo;
    }
    if (!photo) {
      unmatched.push(`${row.number} ${row.author} | ${row.title}`);
      continue;
    }

    const fields = {};
    const excelTitle = String(row.title || '').replace(/^title\s*[:\-–]\s*/i, '').trim();
    if (excelTitle && excelTitle !== (photo.title || '').trim()) {
      fields[F.title] = excelTitle.slice(0, 120);
    }
    if (row.blurb !== undefined && row.blurb !== (photo.blurb || '').trim()) {
      // Allow clearing only if excel has something; skip empty→empty
      if (row.blurb || (photo.blurb || '')) {
        if (row.blurb !== (photo.blurb || '').trim()) {
          fields[F.blurb] = row.blurb.slice(0, 5000);
        }
      }
    }

    if (Object.keys(fields).length) {
      updates.push({
        id: photo.id,
        number: photo.number,
        author: photo.submitter,
        fromTitle: photo.title,
        toTitle: fields[F.title],
        fromBlurb: (photo.blurb || '').slice(0, 80),
        toBlurb: fields[F.blurb] != null ? String(fields[F.blurb]).slice(0, 80) : undefined,
        fields,
      });
    }
  }

  console.log(`\nUpdates needed: ${updates.length}`);
  for (const u of updates.slice(0, 40)) {
    console.log(`  ${u.number}  ${u.author}`);
    if (u.toTitle != null) console.log(`    title: ${JSON.stringify(u.fromTitle)} → ${JSON.stringify(u.toTitle)}`);
    if (u.toBlurb != null) console.log(`    blurb: ${JSON.stringify(u.fromBlurb)} → ${JSON.stringify(u.toBlurb)}`);
  }
  if (updates.length > 40) console.log(`  … +${updates.length - 40} more`);

  if (unmatched.length) {
    console.log(`\nUnmatched excel rows: ${unmatched.length}`);
    unmatched.forEach((u) => console.log(`  ${u}`));
  }

  // Subject/Device are catalogue-only (not on Airtable/website yet)
  const withSubject = excel.filter((r) => r.subject).length;
  const withDevice = excel.filter((r) => r.device).length;
  console.log(`\nNote: Subject (${withSubject}) and Device (${withDevice}) stay in Excel only — not Airtable fields / not shown on site.`);

  if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply to write Airtable.');
    return;
  }

  let ok = 0, fail = 0;
  for (const u of updates) {
    try {
      await at(`${T.photos}/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields: u.fields }),
      });
      ok += 1;
      process.stdout.write('.');
    } catch (e) {
      fail += 1;
      console.log(`\nFAIL ${u.number}: ${e.message}`);
    }
  }
  console.log(`\nDone. updated=${ok} failed=${fail}`);
})().catch((e) => { console.error(e); process.exit(1); });
