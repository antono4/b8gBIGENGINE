# b8g — Big Engine

An application built from the ideas in [`stealify/b8g`](https://github.com/stealify/b8g):
a **capability-based component engine** with a **binary instruction stack**, an
offset-addressed **snapshot format**, and a **Universal Compiler Feedback
Interface** for LLVM, GCC, V8 and GraalVM.

The upstream repository is a design document — a manifesto describing what Big
Engine should be. This project turns that design into working software: a
runtime, a compiler feedback layer, a set of reference components, a CLI and a
web console.

```
                 ┌──────────────────────────────────────────────┐
                 │                  ENGINE                       │
                 │                                               │
  source ────────┼─▶ Universal Compiler Feedback Interface       │
  (any language) │     LLVM · GCC · V8 · GraalVM                 │
                 │                                               │
                 │   Kernel (run + watch)                        │
                 │     ├─ memory pool   (shared / private regions)│
                 │     ├─ contexts      (isolated, secret-keyed)  │
                 │     ├─ capability handles (rights + secrets)   │
                 │     ├─ streams / tasks / events                │
                 │     └─ components    (audit, snapshot, runner) │
                 │                                               │
                 │   Binary stack VM  ──▶ snapshot blob (.b8g)    │
                 └──────────────────────────────────────────────┘
```

## Quick start

Requires Node.js >= 20. No runtime dependencies.

```bash
# run the full pipeline: compile → audit → assemble → execute → snapshot
node bin/b8g.mjs demo

# start the engine HTTP server + web console on http://localhost:12000
node bin/b8g.mjs serve --port 12000

# run the tests
npm test
```

Then open the console and press **run pipeline**.

## Concepts, mapped to code

| b8g concept (README) | Implementation |
| --- | --- |
| Capability-based component model | `src/runtime/capability.mjs`, `src/runtime/component.mjs` |
| Operate on shared memory | `src/runtime/memory.mjs` (`SharedArrayBuffer` regions) |
| Contexts are isolated, linked by a secret symbol | `src/runtime/context.mjs` (`grant()` is the only bridge) |
| Tasks, Streams, Events | `src/runtime/kernel.mjs`, `src/runtime/stream.mjs` |
| Directly executable binary stack format | `src/runtime/isa.mjs`, `src/runtime/vm.mjs` |
| Snapshot: binary serialisation of execution context | `src/runtime/snapshot.mjs` |
| Universal Compiler Feedback Interface | `src/compiler/` |
| Host component with `run` and `watch` | `Kernel#run`, `Kernel#watch` |

## The capability model

A component declares the capabilities it needs and receives **handles**. A handle
couples a target with a rights mask (`read`, `write`, `exec`, `transfer`,
`grant`) and a secret `Symbol`. Nothing else crosses a context boundary.

```js
import { Engine, Right } from 'b8g';

const engine = Engine.boot();

// The audit component can only touch what it was granted:
engine.components.audit.handles.heap.describe();
// -> { name: 'audit-heap', tagName: 'Memory', rightsText: 'read|write', ... }

// Rights can never be amplified by derivation:
const readOnly = engine.components.audit.handles.heap.derive(Right.READ);
```

Attempting to use a capability you do not hold, or to derive rights you do not
have, throws a `CapabilityError`.

## The binary instruction stack

A program is a list of `[mnemonic, ...operands]`. It assembles to a compact
little-endian image that can be walked without tooling.

```js
const { bytes, instructions } = engine.assemble([
  ['PUSH', 6], ['PUSH', 7], ['MUL'], ['PUSH', 2], ['ADD'], ['HALT'],
]);
engine.execute({ name: 'calc', bytes }).stack; // -> [44]
```

Instructions: arithmetic (`ADD`…`MOD`, bitwise ops), comparison and branches
(`JZ`, `JNZ`, `JMP`), calls (`CALL`, `RET`), locals (`LOAD`, `STORE`),
capability-guarded memory (`MLOAD`, `MSTORE`), calls into components (`CALLH`),
and events (`EMIT`). Every memory and call instruction resolves a **handle
index** in the executing context and enforces its rights.

```
 0000  PUSH 6
 0009  PUSH 7
 0018  MUL
 0019  PUSH 2
 0028  ADD
 0029  HALT
```

## Snapshots

A snapshot is a single binary blob: a 128-byte header, JSON payload sections and
raw region bytes addressed by offset.

```
 0   magic          u32   "B8G0"
 4   formatVersion  u16
 6   flags          u16   (bit 0 = rehashable)
 8   contextCount   u32
 16  checksum       u32   fnv1a32 over the payload
 20  payloadLength  u32
 24  nameLength     u16
 32  name           UTF-8, padded to 64 bytes
 96  sectionIndex   u32 x 8  offsets to payload sections
 128 payload ...
```

```bash
node bin/b8g.mjs snapshot engine.b8g
node bin/b8g.mjs inspect engine.b8g
```

```
snapshot b8g-engine
  magic=0x42384730 version=1 rehashable=true
  contexts=4 payload=137567B total=137810B
  checksum=0x3149b8ff valid=true
```

## Universal Compiler Feedback Interface

Every toolchain is reduced to one normalised `Feedback` document: diagnostics,
optimisation remarks, artifacts and timings. That is what lets an engine swap
compilers without changing any downstream component.

| Adapter | Backend | Measured or modelled |
| --- | --- | --- |
| `llvm` | `llvm/<triple>` | modelled pass pipeline, emits `.ll` |
| `gcc` | real `gcc` / `g++` | **measured** via `-fdiagnostics-format=json` |
| `v8` | real `node --print-bytecode` | **measured** Ignition bytecode |
| `graalvm` | JVMCI | measured version, modelled Graal phases |

```bash
node bin/b8g.mjs compile examples/sum.c --lang c
node bin/b8g.mjs compile examples/unit.js --adapters v8,graalvm
node bin/b8g.mjs adapters
```

```
Unit examples/sum.c [c]  pipeline: llvm -> gcc
  ok=true errors=0 warnings=0 remarks=3
  ...
  artifacts:
    examples/sum.c.ll (llvm-ir, 240B)
```

## CLI

```
b8g serve [--port N]        start the HTTP server + web console
b8g info                    engine status, components, capabilities
b8g adapters                list compiler adapters
b8g compile <file>          run the compiler feedback interface
b8g audit <file>            audit a unit for runtime hazards
b8g asm <file>|--demo       assemble a stack program
b8g disasm <file>           disassemble a stack image
b8g run <file>|--demo       assemble + execute
b8g snapshot <out.b8g>      capture an engine snapshot
b8g inspect <in.b8g>        inspect a snapshot header
b8g demo                    full pipeline end to end
```

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/status` | engine state (components, regions, streams, events) |
| GET | `/api/adapters` | compiler adapter capabilities |
| GET | `/api/events` | kernel event bus as Server-Sent Events |
| POST | `/api/compile` | `{ language, source, adapters? }` → feedback document |
| POST | `/api/audit` | `{ source }` → hazard findings + risk score |
| POST | `/api/assemble` | `{ program }` → binary image (base64) + listing |
| POST | `/api/execute` | `{ program \| bytes, trace? }` → stack result |
| POST | `/api/snapshot` | capture + inspect the engine snapshot |
| POST | `/api/pipeline` | the whole pipeline in one call |

## Web console

The console at `/` is a control-room view of the engine: live kernel event bus,
composition graph, compiler diagnostics and remarks, capability audit, an
interactive stack VM with a stack tape, and a snapshot inspector that renders
the header and payload sections.

It is a static page that **boots the real engine in the browser** — the same
`src/` modules the CLI and server use, imported as ES modules — so it runs with
no backend at all. It is published to GitHub Pages at
<https://antono4.github.io/b8gBIGENGINE/>.

Two things differ from a Node engine, both by design:

- `SharedArrayBuffer` requires cross-origin isolation, which a static host
  cannot set, so regions fall back to a private buffer (identical API).
- The GCC and V8 adapters drive child processes, so in the browser they report
  themselves unavailable and fall back to modelled feedback. Everything else —
  capability runtime, stack VM, snapshots, LLVM/GraalVM feedback — is the real
  implementation.

Append `?api=https://host:port` to drive a remote Node engine over HTTP instead,
which re-enables the measured GCC/V8 adapters.

## Project layout

```
bin/b8g.mjs                 CLI
src/runtime/                memory, capabilities, contexts, components, VM, snapshots
src/runtime/api.mjs         the JSON API, shared by the server and the browser engine
src/compiler/               feedback interface + LLVM/GCC/V8/GraalVM adapters
src/components/             audit, snapshot, runner reference components
src/server.mjs              HTTP server + JSON API + SSE
src/browser.mjs             in-page engine entry (used by the console)
index.html, assets/         web console (static, no build step)
examples/                   sample units and stack programs
test/                       node:test suites
```

## Design notes and honest limits

This is a working demonstration of the b8g *design*, not the full system the
upstream README ultimately describes. In particular:

- The stack VM is a real interpreter for a small ISA. It is not a native code
  generator and does not produce machine code.
- The LLVM and GraalVM adapters produce modelled feedback (deterministic
  artifacts, measured facts). Only the GCC and V8 adapters drive real tools.
- Snapshots serialise engine *state* (contexts, capabilities, components,
  regions). They are not V8 heap snapshots; the framing is deliberately
  compatible so a future V8 backend can slot in.
- Memory regions use `SharedArrayBuffer` within one process. Cross-process
  sharing would use the same handle API over a different transport.

The value is the composition: one capability model, one feedback shape, one
snapshot format, reused by every part.

## License

Released into the public domain under [The Unlicense](LICENSE), matching
upstream.
