/**
 * Node builtins are reached through `process.getBuiltinModule` (Node >= 20.16)
 * instead of a static `node:` import. That keeps modules which *may* shell out
 * — the GCC, V8 and GraalVM compiler adapters — loadable in a browser, where
 * `nodeTools()` returns null and the adapter degrades to modelled feedback.
 */
let cached;
let resolved = false;

export function nodeTools() {
  if (resolved) return cached;
  resolved = true;
  cached = null;
  try {
    const getBuiltin =
      typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function'
        ? process.getBuiltinModule.bind(process)
        : null;
    if (!getBuiltin) return cached;

    const childProcess = getBuiltin('node:child_process');
    const fs = getBuiltin('node:fs');
    const os = getBuiltin('node:os');
    const path = getBuiltin('node:path');

    cached = {
      spawnSync: childProcess.spawnSync,
      writeFileSync: fs.writeFileSync,
      mkdtempSync: fs.mkdtempSync,
      rmSync: fs.rmSync,
      tmpdir: os.tmpdir,
      join: path.join,
      execPath: process.execPath,
    };
  } catch {
    cached = null;
  }
  return cached;
}
