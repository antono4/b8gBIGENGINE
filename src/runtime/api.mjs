import { B8GError } from './errors.mjs';

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

/**
 * The engine's JSON API, defined once and shared by the Node HTTP server and
 * the in-browser engine. Each handler receives a parsed request and returns the
 * response body; transport and error status codes are the caller's concern.
 *
 * @param {import('./engine.mjs').Engine} engine
 * @returns {Record<string, (req: {body: object}) => any>}
 */
export function apiRoutes(engine) {
  const artifactList = (report) =>
    report.artifacts.map((a) => ({ name: a.name, kind: a.kind, size: a.bytes.length }));

  return {
    'GET /api/status': () => engine.status(),

    'GET /api/adapters': () => ({ adapters: engine.compiler.list() }),

    // Reports which compiler adapters can drive a real toolchain in this
    // process. The browser console uses it to decide between the in-page
    // engine and a remote one.
    'GET /api/runtime': () => {
      const adapters = engine.compiler.list();
      return {
        runtime: nodeAvailable() ? 'node' : 'browser',
        host: true,
        measuredAdapters: adapters.filter((a) => a.available && !a.feedbackOnly).map((a) => a.name),
      };
    },

    'POST /api/compile': ({ body }) => {
      if (!body.source) throw new B8GError('compile requires `source`', 'BAD_REQUEST');
      const report = engine.compile({
        name: body.name ?? 'unit',
        language: body.language ?? 'ecmascript',
        source: body.source,
        adapters: body.adapters,
      });
      return { ...report, artifacts: artifactList(report) };
    },

    'POST /api/audit': ({ body }) => {
      if (!body.source) throw new B8GError('audit requires `source`', 'BAD_REQUEST');
      return engine.audit({
        name: body.name ?? 'unit',
        language: body.language ?? 'ecmascript',
        source: body.source,
      });
    },

    'POST /api/assemble': ({ body }) => {
      if (!Array.isArray(body.program)) throw new B8GError('assemble requires a `program` array', 'BAD_REQUEST');
      const assembled = engine.assemble(body.program);
      return {
        instructions: assembled.instructions,
        labels: assembled.labels,
        size: assembled.bytes.length,
        bytes: bytesToBase64(assembled.bytes),
      };
    },

    'POST /api/execute': ({ body }) => {
      const bytes = body.bytes
        ? base64ToBytes(body.bytes)
        : engine.assemble(body.program ?? []).bytes;
      return engine.execute({ name: body.name ?? 'program', bytes, trace: body.trace ?? false });
    },

    'POST /api/snapshot': () => {
      const snap = engine.snapshot('b8g-engine');
      return { name: snap.name, size: snap.size, header: snap.header };
    },

    'POST /api/pipeline': ({ body }) => {
      const source = body.source ?? DEFAULT_SOURCE;
      const language = body.language ?? 'ecmascript';
      const name = body.name ?? 'pipeline-unit';

      const compile = engine.compile({ name, language, source });
      const audit = engine.audit({ name, language, source });
      const assembled = engine.assemble(body.program ?? DEFAULT_PROGRAM);
      const executed = engine.execute({ name: `${name}.stack`, bytes: assembled.bytes, trace: body.trace ?? false });
      const snapshot = engine.snapshot(`${name}.snapshot`);

      return {
        compile: { ...compile, artifacts: artifactList(compile) },
        audit,
        assemble: { size: assembled.bytes.length, instructions: assembled.instructions },
        execute: executed,
        snapshot: { name: snapshot.name, size: snapshot.size, header: snapshot.header },
      };
    },

    'GET /api/disassemble': () => {
      const assembled = engine.assemble(DEFAULT_PROGRAM);
      return { instructions: assembled.instructions, size: assembled.bytes.length };
    },
  };
}

/** Base64 helpers that work under both Node and the browser. */
export function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBytes(text) {
  if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(text, 'base64'));
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** True when running under Node (i.e. child processes and temp files exist). */
export function nodeAvailable() {
  return typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function';
}
