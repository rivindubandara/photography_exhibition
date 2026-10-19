/**
 * Airtable's Votes.Status formula only counted the first vote as Valid.
 * This updates it so every non-self vote is Valid (the app enforces max 3).
 *
 * Needs schema.bases:write on the token, or paste the formula manually in Airtable.
 */
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

const FORMULA = 'IF(OR(LEN(ARRAYJOIN({fldUV2H8hye4Zrbkm}))=0, LEN(ARRAYJOIN({fldSDc8ayUbmTB3k3}))=0), "Incomplete", IF(AND(LEN(ARRAYJOIN({fldPTojTMPac1o7yg}))>0, LOWER(ARRAYJOIN({fldPTojTMPac1o7yg}))=LOWER(ARRAYJOIN({fldgwh12yov0w0RYs}))), "Self-vote", "Valid"))';

async function main() {
  if (!process.env.AIRTABLE_TOKEN) {
    console.error('Set AIRTABLE_TOKEN first.');
    process.exit(1);
  }
  const url = `https://api.airtable.com/v0/meta/bases/${process.env.AIRTABLE_BASE_ID}/tables/tblv3r3wm8aemQqkS/fields/fldLgwyAOjTAmmS3g`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ options: { formula: FORMULA } }),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error('Could not update formula via API (' + r.status + ').');
    console.error(text);
    console.log('\nPaste this into Votes → Status (formula field) in Airtable instead:\n');
    console.log(FORMULA);
    process.exit(1);
  }
  console.log('Status formula updated — all non-self votes count as Valid.');
}

main().catch((e) => { console.error(e); process.exit(1); });
