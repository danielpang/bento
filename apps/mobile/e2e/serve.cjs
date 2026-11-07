const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../dist-web');
http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  let file = path.join(root, pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  const ext = path.extname(file);
  res.setHeader('Content-Type', ext === '.js' ? 'text/javascript' : ext === '.png' ? 'image/png' : ext === '.css' ? 'text/css' : 'text/html');
  fs.createReadStream(file).pipe(res);
}).listen(8081, '127.0.0.1');
