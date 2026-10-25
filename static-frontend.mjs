import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.FRONTEND_PORT || 4200);
const DIST_DIR = join(process.cwd(), 'dist', 'local-robot-image-uploader', 'browser');
const FALLBACK_INDEX = join(DIST_DIR, 'index.html');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.wav': 'audio/wav'
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const decodedPath = decodeURIComponent(url.pathname);
    const safePath = normalize(decodedPath).replace(/^(\.\.[/\\])+/, '');
    const requestedPath = join(DIST_DIR, safePath === '/' ? 'index.html' : safePath);
    const filePath = await resolveFilePath(requestedPath);

    response.writeHead(200, {
      'content-type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      pragma: 'no-cache',
      expires: '0'
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Static frontend listening on http://0.0.0.0:${PORT}`);
  console.log(`Serving ${DIST_DIR}`);
});

async function resolveFilePath(path) {
  if (existsSync(path) && (await stat(path)).isFile()) {
    return path;
  }
  return FALLBACK_INDEX;
}
