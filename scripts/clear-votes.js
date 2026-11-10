/**
 * Clear all Votes records and inspect Votes table fields / numbering.
 * Also reports voter linked-vote leftovers.
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

const { at, T, F, listAll, getVoters } = require('../api/_lib/airtable');
const APPLY = process.argv.includes('--apply');
const BASE = process.env.AIRTABLE_BASE_ID;

(async () => {
  // Schema
  const meta = await fetch(`https://api.airtable.com/v0/meta/bases/${BASE}/tables`, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
  }).then((r) => r.json());
  const votesTable = meta.tables.find((t) => t.id === T.votes);
  console.log('Votes table fields:');
  for (const f of votesTable.fields) {
    console.log(`  ${f.id}  ${f.name}  (${f.type})`, f.options ? JSON.stringify(f.options).slice(0, 120) : '');
  }

  // List all vote records with all fields
  const voteRecs = [];
  let offset;
  do {
    const q = new URLSearchParams({ returnFieldsByFieldId: 'true', pageSize: '100' });
    if (offset) q.set('offset', offset);
    const j = await at(`${T.votes}?${q}`);
    voteRecs.push(...j.records);
    offset = j.offset;
  } while (offset);

  console.log(`\nVote records in Airtable: ${voteRecs.length}`);
  for (const r of voteRecs) {
    console.log(`  ${r.id}`, JSON.stringify(r.fields));
  }

  const voters = await getVoters();
  const withVotes = voters.filter((v) => v.votes > 0 || (v.votedPhotoIds || []).length);
  console.log(`\nVoters showing votes via API: ${withVotes.length}`);
  for (const v of withVotes) {
    console.log(`  ${v.name}  votes=${v.votes}  photos=${(v.votedPhotoIds || []).length}`);
  }

  // Raw voter linked Votes field
  const voterRecs = await listAll(T.voters, [F.voterName, F.voterVotes]);
  const linked = voterRecs.filter((r) => (r.fields[F.voterVotes] || []).length);
  console.log(`\nVoters with linked Votes field: ${linked.length}`);
  for (const r of linked) {
    console.log(`  ${r.fields[F.voterName]}  links=${(r.fields[F.voterVotes] || []).length}`);
  }

  if (!APPLY) {
    console.log('\nDry-run. Re-run with --apply to delete all vote records.');
    console.log('Note: the website also caches votes in browser localStorage (nt-votes:…).');
    return;
  }

  // Delete all vote records in batches of 10
  const ids = voteRecs.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const q = new URLSearchParams();
    chunk.forEach((id) => q.append('records[]', id));
    await at(`${T.votes}?${q}`, { method: 'DELETE' });
    console.log(`Deleted ${chunk.length} vote records`);
  }

  // Re-check
  const left = [];
  offset = undefined;
  do {
    const q = new URLSearchParams({ returnFieldsByFieldId: 'true', pageSize: '100' });
    if (offset) q.set('offset', offset);
    const j = await at(`${T.votes}?${q}`);
    left.push(...j.records);
    offset = j.offset;
  } while (offset);
  console.log(`Votes remaining: ${left.length}`);

  const votersAfter = await getVoters();
  const still = votersAfter.filter((v) => v.votes > 0);
  console.log(`Voters still showing votes: ${still.length}`);
  for (const v of still) console.log(`  ${v.name}  ${v.votes}`);
})().catch((e) => { console.error(e); process.exit(1); });
