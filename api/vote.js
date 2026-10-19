const { castVote } = require('./_lib/airtable');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (process.env.VOTING_CLOSED === '1') return res.status(403).json({ error: 'Voting is closed.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const { voterId, photoId } = body;
    if (!/^rec\w{14}$/.test(voterId || '') || !/^rec\w{14}$/.test(photoId || '')) return res.status(400).json({ error: 'Bad request' });
    const r = await castVote(voterId, photoId);
    res.status(r.status).json(r.ok
      ? { ok: true, votes: r.votes, remaining: r.remaining, maxVotes: r.maxVotes }
      : { error: r.error });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
