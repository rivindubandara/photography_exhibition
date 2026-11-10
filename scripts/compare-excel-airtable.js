/**
 * Compare cleaned catalogue Excel against live Airtable.
 * Match by author+title (IDs often drift when rows are inserted).
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

const { getPhotos } = require('../api/_lib/airtable');

const XLSX = process.argv[2]
  || path.join(process.env.USERPROFILE || '', 'Downloads', 'NT Photography Exhibition 2026 — Submissions 1.xlsx');

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^title\s*[:\-–]\s*/i, '')
    .replace(/[il]{2,}/g, (m) => 'i'.repeat(m.length)) // Il/Ill OCR quirks → treat loosely later
    .replace(/[^\w\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function soft(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** Blurbs often differ only by trailing device sentence or curly quotes. */
function blurbCore(s) {
  return soft(s)
    .replace(/Device\(s\)?\s*used to take the photo:?\s*.*$/i, '')
    .replace(/[“”"']/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function readExcel(file) {
  const py = `
from openpyxl import load_workbook
import json, sys
wb = load_workbook(sys.argv[1], data_only=True)
ws = wb.active
headers = [ws.cell(1, c).value for c in range(1, ws.max_column + 1)]
def idx(*names):
  for n in names:
    if n in headers: return headers.index(n) + 1
  return None
cols = {k: idx(n) for k, n in [
  ('number','Submission ID'),('title','Title'),('subject','Subject'),
  ('blurb','Blurb'),('author','Author'),('device','Device')]}
rows = []
for r in range(2, ws.max_row + 1):
  row = {}
  for k, c in cols.items():
    val = ws.cell(r, c).value if c else None
    row[k] = '' if val is None else str(val).strip()
  if row.get('number','').isdigit():
    row['number'] = row['number'].zfill(3)
  rows.append(row)
print(json.dumps({'headers': headers, 'rows': rows}))
`;
  const out = execFileSync('python', ['-c', py, file], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function titleVariants(title) {
  const t = soft(title).replace(/^title\s*[:\-–]\s*/i, '');
  const variants = new Set([t, t.replace(/\.$/, ''), t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")]);
  // Anonymous Il / Ill / II / III
  variants.add(t.replace(/\bIl\b/g, 'II').replace(/\bIll\b/g, 'III'));
  variants.add(t.replace(/\bII\b/g, 'Il').replace(/\bIII\b/g, 'Ill'));
  return [...variants];
}

(async () => {
  if (!fs.existsSync(XLSX)) {
    console.error('Excel not found:', XLSX);
    process.exit(1);
  }
  const { headers, rows: excel } = readExcel(XLSX);
  const photos = await getPhotos();
  console.log('Excel:', XLSX);
  console.log('Headers:', headers.join(' | '));
  console.log(`Excel rows: ${excel.length}  Airtable/website photos: ${photos.length}\n`);

  // Index Airtable by author|title variants
  const byAT = new Map();
  for (const p of photos) {
    for (const tv of titleVariants(p.title)) {
      byAT.set(`${norm(p.submitter)}|${norm(tv)}`, p);
    }
  }

  const titleDiffs = [];
  const blurbDiffs = [];
  const matchedPhotoIds = new Set();
  const unmatchedExcel = [];
  const idDrift = [];

  for (const row of excel) {
    let photo = null;
    for (const tv of titleVariants(row.title)) {
      photo = byAT.get(`${norm(row.author)}|${norm(tv)}`);
      if (photo) break;
    }
    if (!photo) {
      unmatchedExcel.push({
        number: row.number,
        author: row.author,
        title: row.title,
        hasBlurb: !!row.blurb,
      });
      continue;
    }
    matchedPhotoIds.add(photo.id);

    const excelNum = String(row.number || '').replace(/\D/g, '').padStart(3, '0');
    const airNum = String(photo.number || '').padStart(3, '0');
    if (excelNum && airNum && excelNum !== airNum) {
      idDrift.push(`${row.author} | ${row.title}: excel ${excelNum} vs airtable ${airNum}`);
    }

    const excelTitle = soft(row.title).replace(/^title\s*[:\-–]\s*/i, '');
    if (norm(excelTitle) !== norm(photo.title)) {
      titleDiffs.push({
        author: row.author,
        excel: excelTitle,
        airtable: photo.title,
        airNum: photo.number,
      });
    }

    const eb = blurbCore(row.blurb);
    const ab = blurbCore(photo.blurb);
    if (eb !== ab) {
      blurbDiffs.push({
        airNum: photo.number,
        author: row.author,
        title: excelTitle || photo.title,
        excel: eb.slice(0, 120),
        airtable: ab.slice(0, 120),
        excelLen: eb.length,
        airLen: ab.length,
        excelEmpty: !eb,
        airEmpty: !ab,
      });
    }
  }

  const onlyAirtable = photos.filter((p) => !matchedPhotoIds.has(p.id));

  console.log('=== Content match (by Author + Title) ===');
  console.log(`Matched pairs: ${matchedPhotoIds.size}`);
  console.log(`Title text differences (same photo, wording/punctuation): ${titleDiffs.length}`);
  for (const d of titleDiffs) {
    console.log(`  #${d.airNum}  ${d.author}`);
    console.log(`    excel:    ${JSON.stringify(d.excel)}`);
    console.log(`    airtable: ${JSON.stringify(d.airtable)}`);
  }

  console.log(`\nBlurb differences: ${blurbDiffs.length}`);
  const material = blurbDiffs.filter((d) => d.excelEmpty || d.airEmpty || Math.abs(d.excelLen - d.airLen) > 15 || d.excel.slice(0, 60) !== d.airtable.slice(0, 60));
  const minor = blurbDiffs.filter((d) => !material.includes(d));
  console.log(`  material: ${material.length}   minor (trim/punct): ${minor.length}`);
  for (const d of material) {
    console.log(`  #${d.airNum}  ${d.author}  |  ${d.title}`);
    console.log(`    excel (${d.excelLen}):    ${JSON.stringify(d.excel)}${d.excelLen > 120 ? '…' : ''}`);
    console.log(`    airtable (${d.airLen}): ${JSON.stringify(d.airtable)}${d.airLen > 120 ? '…' : ''}`);
  }

  console.log(`\nIn Excel but NOT on website/Airtable (${unmatchedExcel.length}):`);
  for (const u of unmatchedExcel) {
    console.log(`  ${u.number}  ${u.author}  |  ${u.title}${u.hasBlurb ? '' : '  (no blurb)'}`);
  }

  console.log(`\nOn website/Airtable but NOT in Excel (${onlyAirtable.length}):`);
  for (const p of onlyAirtable) {
    console.log(`  ${p.number}  ${p.submitter}  |  ${p.title}`);
  }

  console.log(`\nSubmission ID drift (same photo, different number): ${idDrift.length}`);
  if (idDrift.length && idDrift.length <= 25) idDrift.forEach((l) => console.log(`  ${l}`));
  else if (idDrift.length) console.log(`  (first 15)`), idDrift.slice(0, 15).forEach((l) => console.log(`  ${l}`));

  console.log(`\nSubject filled in excel: ${excel.filter((r) => r.subject).length}/${excel.length}`);
  console.log(`Device filled in excel:  ${excel.filter((r) => r.device).length}/${excel.length}`);
})().catch((e) => { console.error(e); process.exit(1); });
