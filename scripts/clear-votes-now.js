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

const { at, T, F, getVoters } = require('../api/_lib/airtable');

(async () => {
  const voteRecs = [];
  let offset;
  do {
    const q = new URLSearchParams({ returnFieldsByFieldId: 'true', pageSize: '100' });
    q.append('fields[]', F.voteVoter);
    q.append('fields[]', F.votePhoto);
    if (offset) q.set('offset', offset);
    const j = await at(`${T.votes}?${q}`);
    voteRecs.push(...j.records);
    offset = j.offset;
  } while (offset);

  console.log(`Vote records: ${voteRecs.length}`);
  const voters = await getVoters();
  const nameById = Object.fromEntries(voters.map((v) => [v.id, v.name]));
  for (const r of voteRecs) {
    const voterId = Array.isArray(r.fields[F.voteVoter]) ? r.fields[F.voteVoter][0] : r.fields[F.voteVoter];
    console.log(`  ${r.id}  voter=${nameById[voterId] || voterId}`);
  }

  for (let i = 0; i < voteRecs.length; i += 10) {
    const chunk = voteRecs.slice(i, i + 10).map((r) => r.id);
    const q = new URLSearchParams();
    chunk.forEach((id) => q.append('records[]', id));
    await at(`${T.votes}?${q}`, { method: 'DELETE' });
    console.log(`Deleted ${chunk.length}`);
  }

  const after = await getVoters();
  const still = after.filter((v) => v.votes > 0);
  console.log(`Remaining vote records cleared. Voters still showing votes via API: ${still.length}`);
  for (const v of still) console.log(`  ${v.name}  ${v.votes}`);
})().catch((e) => { console.error(e); process.exit(1); });
