import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist');
const port = Number(process.argv[3] ?? 4173);
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.map':'application/json; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.mp3':'audio/mpeg','.ogg':'audio/ogg','.wav':'audio/wav','.m4a':'audio/mp4','.webm':'video/webm','.mp4':'video/mp4','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf'};
const server = createServer(async (req, res) => {
  try {
    const raw = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const relative = raw === '/' ? 'index.html' : raw.replace(/^\/+/, '');
    let file = join(root, relative);
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, {'content-type': types[extname(file)] ?? 'application/octet-stream'});
    res.end(data);
  } catch {
    res.writeHead(404, {'content-type':'text/plain; charset=utf-8'});
    res.end('Not found');
  }
});
server.listen(port, () => console.log(`Preview: http://localhost:${port}`));
