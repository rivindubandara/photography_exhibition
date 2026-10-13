// Local preview. With AIRTABLE_TOKEN set it uses the real API handlers; otherwise serves mock data.
const http = require('http'), fs = require('fs'), path = require('path');
try { require('fs').readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m || process.env[m[1]]) return;
  let v = m[2]; if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[m[1]] = v;
}); } catch {}
const root = path.join(__dirname, '..', 'public');
const mime = { '.html': 'text/html', '.png': 'image/png', '.otf': 'font/otf', '.svg': 'image/svg+xml', '.js': 'text/javascript' };
const real = !!process.env.AIRTABLE_TOKEN;

const mock = {
  voters: ['Ava Lee', 'Ben Cho', 'Cara Diaz', 'Dan Wu', 'Eli Park'].map((n, i) => ({ id: 'recVOTER' + String(i).padStart(7, '0'), name: n, key: 'k' + i, voted: false })),
  photos: Array.from({ length: 8 }, (_, i) => ({ id: 'recPHOTO' + String(i).padStart(7, '0'), number: String(i + 1).padStart(3, '0'), title: ['Ajar', 'Last Light', 'Crossing', 'Fog Line', 'Half-Open', 'Shore Break', 'Between Floors', 'Drawn'][i],
    submitter: ['Ava Lee', 'Ben Cho', 'Cara Diaz', 'Dan Wu', 'Eli Park', 'Ava Lee', 'Ben Cho', 'Cara Diaz'][i],
    thumb: `/mock/${i}.svg`, full: `/mock/${i}.svg`, ownerKeys: ['k' + (i % 5)] })),
  votes: [],
  adminToken: null,
};
const cols = ['#b06645', '#9c8f7d', '#6a6a59', '#cecea8', '#d4c9bf', '#3d3935'];

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = async (req) => { let b = ''; for await (const c of req) b += c; return b; };
const PORT = Number(process.env.PORT) || 3000;

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) {
    if (real) {
      const name = url.slice(5).replace(/\/$/, '');
      const file = path.join(__dirname, '..', 'api', name + '.js');
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      const h = require(file);
      req.body = await readBody(req);
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
      return h(req, res);
    }
    if (url === '/api/photos') return send(res, 200, { photos: mock.photos });
    if (url === '/api/voters') return send(res, 200, { voters: mock.voters });
    if (url === '/api/vote') {
      const { voterId, photoId } = JSON.parse(await readBody(req));
      const v = mock.voters.find((x) => x.id === voterId), p = mock.photos.find((x) => x.id === photoId);
      if (v.voted) return send(res, 409, { error: 'This name has already voted.' });
      if (p.ownerKeys.includes(v.key)) return send(res, 403, { error: "You can't vote for your own photo." });
      v.voted = true; mock.votes.push({ voterId, photoId }); return send(res, 200, { ok: true });
    }
    if (url === '/api/admin') {
      const pw = process.env.ADMIN_PASSWORD || 'admin';
      const body = JSON.parse(await readBody(req) || '{}');
      const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (body.password === pw || (mock.adminToken && auth === mock.adminToken)) {
        mock.adminToken = mock.adminToken || require('crypto').createHash('sha256').update('mock-admin').digest('hex');
        return send(res, 200, { ok: true, token: mock.adminToken });
      }
      return send(res, 401, { error: 'Wrong password.' });
    }
    if (url === '/api/upload') {
      const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!mock.adminToken || auth !== mock.adminToken) return send(res, 401, { error: 'Unlock admin first.' });
      const body = JSON.parse(await readBody(req) || '{}');
      const n = String(mock.photos.length + 1).padStart(3, '0');
      const id = 'recPHOTO' + String(mock.photos.length).padStart(7, '0');
      const i = mock.photos.length % 6;
      const photo = { id, number: n, title: body.title || 'Untitled', thumb: `/mock/${i}.svg`, full: `/mock/${i}.svg`, ownerKeys: [] };
      mock.photos.push(photo);
      return send(res, 200, { ok: true, photo });
    }
    return send(res, 404, { error: 'not found' });
  }
  if (url.startsWith('/mock/')) {
    const i = parseInt(url.slice(6), 10);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="${cols[i % 6]}"/><circle cx="${60 + i * 40}" cy="400" r="${140 + i * 8}" fill="#f0ede8" opacity=".35"/><rect x="40" y="40" width="320" height="320" fill="none" stroke="#f0ede8" stroke-opacity=".25" stroke-width="2"/></svg>`);
  }
  const rel = url === '/' ? 'index.html' : url === '/admin' ? 'admin.html' : url;
  const f = path.join(root, rel);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => {
  console.log('http://localhost:' + PORT + ' ' + (real ? '(Airtable)' : '(mock data)') + ' · admin /admin');
});
