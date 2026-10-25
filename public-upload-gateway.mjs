import { createServer, request as httpRequest } from 'node:http';

const GATEWAY_PORT = Number(process.env.PUBLIC_UPLOAD_GATEWAY_PORT ?? 3300);
const BACKEND_HOST = process.env.PUBLIC_UPLOAD_BACKEND_HOST || '127.0.0.1';
const BACKEND_PORT = Number(process.env.PUBLIC_UPLOAD_BACKEND_PORT ?? 3000);

const allowedPath = (url = '') => {
  const path = url.split('?')[0] ?? '';
  return path === '/upload-health' || /^\/mobile-upload\/[a-f0-9-]{20,}$/i.test(path);
};

const server = createServer((clientRequest, clientResponse) => {
  clientResponse.setHeader('access-control-allow-origin', '*');
  clientResponse.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  clientResponse.setHeader('access-control-allow-headers', 'content-type');

  if (clientRequest.method === 'OPTIONS') {
    clientResponse.writeHead(204);
    clientResponse.end();
    return;
  }

  if (!['GET', 'POST'].includes(clientRequest.method ?? '') || !allowedPath(clientRequest.url)) {
    clientResponse.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    clientResponse.end('Not found');
    return;
  }

  const proxyRequest = httpRequest({
    hostname: BACKEND_HOST,
    port: BACKEND_PORT,
    path: clientRequest.url,
    method: clientRequest.method,
    headers: getProxyHeaders(clientRequest.headers)
  }, (proxyResponse) => {
    clientResponse.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
    proxyResponse.pipe(clientResponse);
  });

  proxyRequest.on('error', () => {
    if (!clientResponse.headersSent) {
      clientResponse.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    clientResponse.end('Upload gateway could not reach the local backend.');
  });

  clientRequest.pipe(proxyRequest);
});

function getProxyHeaders(headers) {
  const proxyHeaders = {};
  if (headers['content-type']) {
    proxyHeaders['content-type'] = headers['content-type'];
  }
  if (headers['content-length']) {
    proxyHeaders['content-length'] = headers['content-length'];
  }
  return proxyHeaders;
}

server.listen(GATEWAY_PORT, '127.0.0.1', () => {
  console.log(`Public upload gateway listening on http://127.0.0.1:${GATEWAY_PORT}`);
});
