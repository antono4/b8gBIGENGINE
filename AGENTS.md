# AGENTS.md — b8g (Big Engine)

Repository-specific notes for future sessions.

## What this is

An application built from the design in [`stealify/b8g`](https://github.com/stealify/b8g)
(upstream is a README-only manifesto). It implements a capability-based
component engine, a binary instruction stack + VM, an offset-addressed snapshot
format, and a Universal Compiler Feedback Interface for LLVM/GCC/V8/GraalVM.

Zero runtime dependencies. ESM only. Node >= 20.

## Commands

```bash
npm test                              # node:test suites in test/
node bin/b8g.mjs demo                 # full pipeline end to end
node bin/b8g.mjs serve --port 12000   # HTTP server + web console
node bin/b8g.mjs compile <file>       # compiler feedback
node bin/b8g.mjs info                 # engine status
```

Run a single suite: `node --test test/compiler.test.mjs`
(Do not use `node --test test/` — it fails on this Node; use the glob.)

## Architecture

- `src/runtime/memory.mjs` — `MemoryRegion` over `SharedArrayBuffer`; `MemoryPool`.
- `src/runtime/capability.mjs` — `CapabilityHandle`: target + rights mask + secret
  `Symbol`. `derive()` may only narrow rights.
- `src/runtime/context.mjs` — isolated handle table. `grant()` is the **only**
  bridge between contexts. `byIndex()` resolves handles for the VM.
- `src/runtime/component.mjs` — component = manifest (`requires`/`provides`) +
  factory receiving a handle bag. Factory result is the export surface.
- `src/runtime/kernel.mjs` — host component: pool, registry, task queue, event
  bus, and the `run` / `watch` verbs. `api()` exposes `snapshot` and `Vm` to
  component factories.
- `src/runtime/isa.mjs` — assembler/disassembler. Operand shapes in `SHAPES`;
  binary operand widths are u8/u16/u32/f64 little-endian.
- `src/runtime/vm.mjs` — stack interpreter. `MLOAD`/`MSTORE`/`CALLH`/`EMIT`
  operands are **handle table indices**, resolved via `Context#byIndex`.
- `src/runtime/snapshot.mjs` — 128-byte header (magic `0x42384730`), 8 JSON
  payload sections, raw region bytes + trailer table. FNV-1a32 checksum over
  the payload only. Header field offsets are constants at the top of the file.
- `src/compiler/` — `feedback.mjs` defines the normalised shape; `adapters/`
  has llvm (modelled), gcc (real `-fdiagnostics-format=json`), v8 (real
  `node --print-bytecode`), graalvm (measured version, modelled phases).
  `analyze.mjs` is the shared static analyser.
- `src/server.mjs` — JSON API + SSE event bus + static file serving. The repo
  root is the document root; an allowlist exposes `index.html`, `assets/`,
  `src/` and `examples/` so the local server mirrors GitHub Pages.
- `src/runtime/api.mjs` — the JSON API defined once (`apiRoutes`). Both the
  server and the in-page engine dispatch through it, so they cannot drift.
- `src/browser.mjs` — in-page engine entry. `index.html` + `assets/` is the
  static console (no build step); it imports this module and calls the same API
  table. `?api=https://host:port` switches to a remote engine.

## Gotchas

- GitHub Pages serves the repo root. `.nojekyll` is required so `.mjs` under
  `src/` is served verbatim (Jekyll would otherwise skip it).
- `SharedArrayBuffer` is absent on non-isolated hosts; `MemoryRegion` falls
  back to `ArrayBuffer` (`typeof SharedArrayBuffer !== 'undefined'`).
- Node builtins are loaded via `process.getBuiltinModule` in
  `src/compiler/adapters/node-tools.mjs`, so the gcc/v8/graalvm adapter modules
  import cleanly in a browser. Do not reintroduce static `node:` imports in
  anything reachable from `src/browser.mjs`.
- Snapshot name field is at header offset 32 (64 bytes); section index at 96.
- VM handle operands are **indices**, not ids — do not reintroduce id encoding.
- Compiler feedback is deduped across passes by `severity|pass|message` for
  diagnostics and `pass|message` for remarks.
- Adapters that shell out (`gcc`, `v8`) must degrade gracefully when the tool is
  absent; tests skip on availability.

## Style

- No comments that restate code. Comment only non-obvious invariants.
- Keep the capability model honest: never widen rights, never add a side channel
  between contexts.
