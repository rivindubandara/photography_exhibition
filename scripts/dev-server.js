// Local preview. With AIRTABLE_TOKEN set it uses the real API handlers; otherwise serves mock data.
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'public');
const mime = { '.html': 'text/html', '.png': 'image/png', '.otf': 'font/otf', '.svg': 'image/svg+xml', '.js': 'text/javascript' };
const real = !!process.env.AIRTABLE_TOKEN;

const mock = {
  voters: ['Ava Lee', 'Ben Cho', 'Cara Diaz', 'Dan Wu', 'Eli Park'].map((n, i) => ({ id: 'recVOTER' + String(i).padStart(7, '0'), name: n, key: 'k' + i, voted: false })),
  photos: Array.from({ length: 8 }, (_, i) => ({ id: 'recPHOTO' + String(i).padStart(7, '0'), number: String(i + 1).padStart(3, '0'), title: ['Morning Light', 'Atrium', 'Site Visit', 'Harbour', 'Concrete', 'Fern', 'Stairwell', 'Dusk'][i],
    thumb: `/mock/${i}.svg`, full: `/mock/${i}.svg`, ownerKeys: ['k' + (i % 5)] })),
  votes: [],
};
const cols = ['#b06645', '#9c8f7d', '#6a6a59', '#cecea8', '#d4c9bf', '#3d3935'];

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) {
    if (real) {
      const h = require('../api/' + url.slice(5) + '.js');
      let body = ''; for await (const c of req) body += c;
      req.body = body;
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
      return h(req, res);
    }
    if (url === '/api/photos') return send(res, 200, { photos: mock.photos });
    if (url === '/api/voters') return send(res, 200, { voters: mock.voters });
    if (url === '/api/vote') {
      let b = ''; for await (const c of req) b += c; const { voterId, photoId } = JSON.parse(b);
      const v = mock.voters.find((x) => x.id === voterId), p = mock.photos.find((x) => x.id === photoId);
      if (v.voted) return send(res, 409, { error: 'This name has already voted.' });
      if (p.ownerKeys.includes(v.key)) return send(res, 403, { error: "You can't vote for your own photo." });
      v.voted = true; mock.votes.push({ voterId, photoId }); return send(res, 200, { ok: true });
    }
  }
  if (url.startsWith('/mock/')) {
    const i = parseInt(url.slice(6), 10);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="${cols[i % 6]}"/><circle cx="${60 + i * 40}" cy="300" r="${140 + i * 8}" fill="#f0ede8" opacity=".35"/></svg>`);
  }
  const f = path.join(root, url === '/' ? 'index.html' : url);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(3000, () => console.log('http://localhost:3000 ' + (real ? '(Airtable)' : '(mock data)')));
