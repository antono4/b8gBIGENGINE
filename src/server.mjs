import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './runtime/engine.mjs';
import { B8GError } from './runtime/errors.mjs';
import { apiRoutes, DEFAULT_SOURCE, DEFAULT_PROGRAM } from './runtime/api.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_DIR = resolve(__dirname, '..');

// The repo root doubles as the document root: index.html + assets/ are the
// console, /src/ is the engine the page imports. Everything else (docs, tests,
// tooling) is hidden behind an allowlist so the local server mirrors what
// GitHub Pages exposes.
const PUBLIC_PREFIXES = ['/assets/', '/src/', '/examples/'];
const PUBLIC_FILES = new Set(['/index.html', '/favicon.svg']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    ...headers,
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 8 * 1024 * 1024) throw new B8GError('request body too large', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new B8GError('request body is not valid JSON', 'BAD_JSON');
  }
}

/**
 * Create the b8g HTTP server.
 *
 * @param {{engine?: Engine, rootDir?: string}} [opts]
 */
export function createB8GServer(opts = {}) {
  const engine = opts.engine ?? Engine.boot();
  const rootDir = opts.rootDir ?? REPO_DIR;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      res.end();
      return;
    }

    if (pathname.startsWith('/api/')) {
      try {
        await handleApi(req, res, pathname, engine);
      } catch (err) {
        const status = err instanceof B8GError ? 400 : 500;
        send(res, status, { error: err.message, code: err.code ?? 'INTERNAL', details: err.details ?? null });
      }
      return;
    }

    if (!isPublicPath(pathname)) {
      return send(res, 404, { error: `not found: ${pathname}` });
    }
    await serveStatic(res, pathname, rootDir);
  });

  return { server, engine };
}

async function handleApi(req, res, pathname, engine) {
  if (req.method === 'GET' && pathname === '/api/events') {
    return streamEvents(res, engine);
  }
  const routes = apiRoutes(engine);
  const handler = routes[`${req.method} ${pathname}`];
  if (!handler) return send(res, 404, { error: `no route for ${req.method} ${pathname}` });
  const body = req.method === 'POST' ? await readBody(req) : {};
  return send(res, 200, handler({ body }));
}

function streamEvents(res, engine) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  });
  res.write(': connected\n\n');
  const unsubscribe = engine.watch((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  res.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
}

function isPublicPath(pathname) {
  if (pathname === '/' || PUBLIC_FILES.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

async function serveStatic(res, pathname, rootDir) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(rootDir, rel);
  if (!filePath.startsWith(rootDir)) {
    return send(res, 403, { error: 'forbidden' });
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'content-length': data.length,
    });
    res.end(data);
  } catch {
    send(res, 404, { error: `not found: ${pathname}` });
  }
}
