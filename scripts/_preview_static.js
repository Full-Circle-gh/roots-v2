// Throwaway static server for previewing public/shop.html WITHOUT the DB-backed
// app server (the real server.js needs sqlite native bindings that don't load in
// this sandbox). Serves public/ and maps /assets/fonts/* -> public/fonts/*.
// Not shipped — used only for local visual checks.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const PORT = 4173;
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.ttf':'font/ttf', '.otf':'font/otf', '.png':'image/png', '.jpg':'image/jpeg',
  '.svg':'image/svg+xml', '.json':'application/json', '.ico':'image/x-icon' };

http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/' ) url = '/shop.html';
  if (url.startsWith('/assets/fonts/')) url = '/fonts/' + url.slice('/assets/fonts/'.length);
  const file = path.join(ROOT, path.normalize(url));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, () => console.log('preview-static on http://localhost:' + PORT));
