/* Throwaway static server for previewing the block gallery without booting the
 * full app (which needs the DB). Mirrors server.js's mount: /assets/* -> public/*.
 * Run: node scripts/_gallery_serve.js   then open http://localhost:8731/assets/shop/_gallery.html
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = 8731;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.otf': 'font/otf', '.ttf': 'font/ttf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif',
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.startsWith('/assets/')) p = p.slice('/assets'.length); // /assets/x -> /x under public
  if (p === '/' || p === '') p = '/shop/_gallery.html';
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('no'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found: ' + p); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, () => console.log('gallery preview: http://localhost:' + PORT + '/assets/shop/_gallery.html'));
