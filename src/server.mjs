import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './runtime/engine.mjs';
import { B8GError } from './runtime/errors.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '../public');

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
 * @param {{engine?: Engine, publicDir?: string}} [opts]
 */
export function createB8GServer(opts = {}) {
  const engine = opts.engine ?? Engine.boot();
  const publicDir = opts.publicDir ?? PUBLIC_DIR;

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

    await serveStatic(res, pathname, publicDir);
  });

  return { server, engine };
}

async function handleApi(req, res, pathname, engine) {
  const route = `${req.method} ${pathname}`;
  switch (route) {
    case 'GET /api/status':
      return send(res, 200, engine.status());

    case 'GET /api/adapters':
      return send(res, 200, { adapters: engine.compiler.list() });

    case 'GET /api/events':
      return streamEvents(res, engine);

    case 'POST /api/compile': {
      const body = await readBody(req);
      if (!body.source) throw new B8GError('compile requires `source`', 'BAD_REQUEST');
      const report = engine.compile({
        name: body.name ?? 'unit',
        language: body.language ?? 'ecmascript',
        source: body.source,
        adapters: body.adapters,
      });
      return send(res, 200, { ...report, artifacts: report.artifacts.map((a) => ({ name: a.name, kind: a.kind, size: a.bytes.length })) });
    }

    case 'POST /api/audit': {
      const body = await readBody(req);
      if (!body.source) throw new B8GError('audit requires `source`', 'BAD_REQUEST');
      const record = engine.audit({ name: body.name ?? 'unit', language: body.language ?? 'ecmascript', source: body.source });
      return send(res, 200, record);
    }

    case 'POST /api/assemble': {
      const body = await readBody(req);
      if (!Array.isArray(body.program)) throw new B8GError('assemble requires a `program` array', 'BAD_REQUEST');
      const assembled = engine.assemble(body.program);
      return send(res, 200, {
        instructions: assembled.instructions,
        labels: assembled.labels,
        size: assembled.bytes.length,
        bytes: Buffer.from(assembled.bytes).toString('base64'),
      });
    }

    case 'POST /api/execute': {
      const body = await readBody(req);
      const bytes = body.bytes
        ? Uint8Array.from(Buffer.from(body.bytes, 'base64'))
        : engine.assemble(body.program ?? []).bytes;
      const result = engine.execute({ name: body.name ?? 'program', bytes, trace: body.trace ?? false });
      return send(res, 200, result);
    }

    case 'POST /api/snapshot': {
      const snap = engine.snapshot('b8g-engine');
      return send(res, 200, { name: snap.name, size: snap.size, header: snap.header });
    }

    case 'POST /api/pipeline': {
      const body = await readBody(req);
      const source = body.source ?? DEFAULT_SOURCE;
      const language = body.language ?? 'ecmascript';
      const name = body.name ?? 'pipeline-unit';

      const compile = engine.compile({ name, language, source });
      const audit = engine.audit({ name, language, source });
      const assembled = engine.assemble(body.program ?? DEFAULT_PROGRAM);
      const executed = engine.execute({ name: `${name}.stack`, bytes: assembled.bytes, trace: body.trace ?? false });
      const snapshot = engine.snapshot(`${name}.snapshot`);

      return send(res, 200, {
        compile: { ...compile, artifacts: compile.artifacts.map((a) => ({ name: a.name, kind: a.kind, size: a.bytes.length })) },
        audit,
        assemble: { size: assembled.bytes.length, instructions: assembled.instructions },
        execute: executed,
        snapshot: { name: snapshot.name, size: snapshot.size, header: snapshot.header },
      });
    }

    case 'GET /api/disassemble': {
      const assembled = engine.assemble(DEFAULT_PROGRAM);
      return send(res, 200, { instructions: assembled.instructions, size: assembled.bytes.length });
    }

    default:
      return send(res, 404, { error: `no route for ${route}` });
  }
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

async function serveStatic(res, pathname, publicDir) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDir, rel);
  if (!filePath.startsWith(publicDir)) {
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

export const DEFAULT_SOURCE = `// A unit of AI-generated code about to run in the engine.
function sum(values) {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
const unused = 42;
globalThis.cache = sum([1, 2, 3]);
`;

export const DEFAULT_PROGRAM = [
  ['PUSH', 6],
  ['PUSH', 7],
  ['MUL'],
  ['PUSH', 2],
  ['ADD'],
  ['HALT'],
];
