/**
 * Recreate Votes "Vote #" autoNumber so the next vote starts at 1.
 * (Airtable autoNumber does not reset when records are deleted.)
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

const { T, at } = require('../api/_lib/airtable');
const BASE = process.env.AIRTABLE_BASE_ID;
const TOKEN = process.env.AIRTABLE_TOKEN;
const VOTE_NUM_FIELD = 'fldFSxeVmjlUmkvxK';
const APPLY = process.argv.includes('--apply');

async function meta(pathname, opts = {}) {
  const r = await fetch(`https://api.airtable.com/v0/meta/bases/${BASE}${pathname}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j?.error?.message || j?.message || `Meta ${r.status}`);
    e.status = r.status;
    e.body = j;
    throw e;
  }
  return j;
}

(async () => {
  // Confirm no votes remain
  const votes = await at(`${T.votes}?pageSize=1&returnFieldsByFieldId=true`);
  const count = (votes.records || []).length;
  console.log(`Current vote records: ${count}${votes.offset ? '+' : ''}`);
  if (count > 0) {
    console.error('Votes table is not empty — clear votes first, then reset numbering.');
    process.exit(1);
  }

  // Airtable Meta API can't delete fields or change type — rename old, create fresh autoNumber.
  console.log(`Will rename ${VOTE_NUM_FIELD} → "Vote # (retired)" and create a new "Vote #" autoNumber.`);
  if (!APPLY) {
    console.log('Dry-run. Re-run with --apply to reset.');
    return;
  }

  await meta(`/tables/${T.votes}/fields/${VOTE_NUM_FIELD}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Vote # (retired)' }),
  });
  console.log('Renamed old Vote # field.');

  const created = await meta(`/tables/${T.votes}/fields`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Vote #',
      type: 'autoNumber',
    }),
  });
  console.log(`Created new Vote # field: ${created.id}`);
  console.log('Next vote record will get Vote # = 1.');
  console.log('You can delete "Vote # (retired)" manually in Airtable if you want.');
})().catch((e) => {
  console.error(e.message, e.body || '');
  process.exit(1);
});
