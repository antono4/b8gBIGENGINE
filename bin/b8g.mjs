#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { Engine } from '../src/runtime/engine.mjs';
import { createB8GServer, DEFAULT_SOURCE, DEFAULT_PROGRAM } from '../src/server.mjs';
import { inspectSnapshot } from '../src/runtime/snapshot.mjs';
import { OpName, TagName, rightsToString } from '../src/runtime/constants.mjs';
import { disassemble } from '../src/runtime/isa.mjs';

const USAGE = `b8g — Big Engine CLI

Usage: b8g <command> [options]

Commands
  serve [--port N] [--host H]     start the engine HTTP server + web console
  info                            print engine status, components and capabilities
  adapters                        list compiler adapters and their capabilities
  compile <file|--lang L>         run the universal compiler feedback interface
  audit <file>                    audit a unit for runtime hazards
  asm <file|--demo>               assemble a stack program (JSON array of [op, ...args])
  disasm <file>                   disassemble a binary stack image
  run <file|--demo>               assemble + execute a stack program
  snapshot <out.b8g>              capture an engine snapshot
  inspect <in.b8g>                inspect a snapshot header
  demo                            run the full pipeline end-to-end

Options
  --lang <language>               ecmascript | typescript | c | cpp | rust | java ...
  --adapters a,b                  force a compiler pipeline
  --trace                         emit a VM execution trace
  --json                          machine-readable output
  --port, --host                  server bind options
  --help
`;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.flags[key] = next;
        i++;
      } else {
        args.flags[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function readSource(path) {
  if (!path) return DEFAULT_SOURCE;
  return readFileSync(path, 'utf8');
}

function color(level, text) {
  const codes = { error: '\x1b[31m', warning: '\x1b[33m', note: '\x1b[36m', remark: '\x1b[35m', fatal: '\x1b[41m\x1b[37m' };
  const code = codes[level] ?? '\x1b[32m';
  return process.stdout.isTTY ? `${code}${text}\x1b[0m` : text;
}

function printFeedback(report) {
  console.log(`\n\x1b[1mUnit\x1b[0m ${report.unit.name} [${report.unit.language}]  pipeline: ${report.pipeline.join(' -> ')}`);
  console.log(`  ok=${report.ok} errors=${report.summary.errors} warnings=${report.summary.warnings} remarks=${report.summary.remarks}\n`);
  for (const d of report.diagnostics) {
    console.log(`  ${color(d.severity, `[${d.severity}]`)} ${d.pass ? `(${d.pass}) ` : ''}${d.message}${d.hint ? `\n      hint: ${d.hint}` : ''}`);
  }
  if (report.remarks.length) {
    console.log('\n  remarks:');
    for (const r of report.remarks) {
      console.log(`    ${color('remark', `(${r.pass})`)} ${r.message}${r.impact ? ` [impact ${r.impact}]` : ''}`);
    }
  }
  if (report.artifacts.length) {
    console.log('\n  artifacts:');
    for (const a of report.artifacts) console.log(`    ${a.name} (${a.kind}, ${a.bytes.length}B)`);
  }
}

function printStatus(status) {
  console.log(`\n\x1b[1mb8g\x1b[0m ${status.name}  uptime ${status.uptimeMs}ms  clock ${status.clock}`);
  console.log(`  memory: ${status.memory.bytesAllocated} bytes across ${status.memory.regions.length} regions`);
  for (const r of status.memory.regions) console.log(`    - ${r.name} ${r.size}B ${r.shared ? 'shared' : 'private'} r=${r.reads} w=${r.writes}`);
  console.log(`  components:`);
  for (const c of status.components) {
    console.log(`    - ${c.name}@${c.version} [${c.status}] requires=[${c.requires.join(',')}] provides=[${c.provides.join(',')}]`);
    for (const [name, h] of Object.entries(c.handles)) {
      console.log(`        ${name}: ${TagName[h.tag]} ${rightsToString(h.rights)}`);
    }
  }
  console.log(`  streams:`);
  for (const s of status.streams) console.log(`    - ${s.name}: ${s.total} events, ${s.listeners} listeners`);
  console.log(`  tasks: ${status.tasks.length}, events: ${status.events.length}`);
}

function printSnapshotHeader(header) {
  console.log(`\n\x1b[1msnapshot\x1b[0m ${header.name}`);
  console.log(`  magic=${header.magic} version=${header.version} rehashable=${header.rehashable}`);
  console.log(`  contexts=${header.contextCount} payload=${header.payloadLength}B total=${header.totalSize}B`);
  console.log(`  checksum=0x${header.checksum.toString(16)} valid=${header.checksumValid}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? 'help';
  const flags = args.flags;

  if (command === 'help' || flags.help) {
    console.log(USAGE);
    return;
  }

  if (command === 'serve') {
    const port = Number(flags.port ?? process.env.PORT ?? 12000);
    const host = flags.host ?? '0.0.0.0';
    const { server, engine } = createB8GServer();
    server.listen(port, host, () => {
      console.log(`b8g engine listening on http://${host}:${port}`);
      console.log(`  console:  http://localhost:${port}/`);
      console.log(`  status:   http://localhost:${port}/api/status`);
      console.log(`  events:   http://localhost:${port}/api/events (SSE)`);
      void engine;
    });
    return;
  }

  const engine = Engine.boot();

  switch (command) {
    case 'info':
      printStatus(engine.status());
      return;

    case 'adapters': {
      const adapters = engine.compiler.list();
      if (flags.json) return console.log(JSON.stringify(adapters, null, 2));
      console.log('\n\x1b[1mcompiler adapters\x1b[0m');
      for (const a of adapters) {
        console.log(`  ${a.name}  backend=${a.backend} available=${a.available} feedbackOnly=${a.feedbackOnly}`);
        console.log(`      languages: ${a.languages.join(', ')}`);
        console.log(`      passes:    ${a.passes.join(' -> ')}`);
      }
      return;
    }

    case 'compile': {
      const source = readSource(args._[1]);
      const language = flags.lang ?? guessLanguage(args._[1]) ?? 'ecmascript';
      const report = engine.compile({
        name: args._[1] ?? 'unit',
        language,
        source,
        adapters: flags.adapters ? String(flags.adapters).split(',') : undefined,
      });
      if (flags.json) return console.log(JSON.stringify(report, (k, v) => (v instanceof Uint8Array ? `[${v.length} bytes]` : v), 2));
      printFeedback(report);
      return;
    }

    case 'audit': {
      const source = readSource(args._[1]);
      const language = flags.lang ?? guessLanguage(args._[1]) ?? 'ecmascript';
      const record = engine.audit({ name: args._[1] ?? 'unit', language, source });
      if (flags.json) return console.log(JSON.stringify(record, null, 2));
      console.log(`\n\x1b[1maudit\x1b[0m ${record.unit} riskScore=${record.riskScore}`);
      for (const f of record.findings) console.log(`  ${color(f.severity, `[${f.severity}]`)} ${f.rule} x${f.count} — ${f.note}`);
      if (!record.findings.length) console.log('  clean');
      return;
    }

    case 'asm': {
      const program = flags.demo ? DEFAULT_PROGRAM : JSON.parse(readSource(args._[1]));
      const assembled = engine.assemble(program);
      if (flags.json) {
        return console.log(
          JSON.stringify({ instructions: assembled.instructions, labels: assembled.labels, size: assembled.bytes.length }, null, 2),
        );
      }
      console.log(`\n\x1b[1massembled\x1b[0m ${assembled.bytes.length} bytes, ${assembled.instructions.length} instructions`);
      for (const i of assembled.instructions) console.log(`  ${String(i.pc).padStart(4)}  ${i.name} ${i.operands.join(' ')}`);
      return;
    }

    case 'disasm': {
      const bytes = readBytes(args._[1]);
      const listing = disassemble(bytes);
      console.log(`\n\x1b[1mdisassembly\x1b[0m ${bytes.length} bytes`);
      for (const i of listing) console.log(`  ${String(i.pc).padStart(4)}  ${i.name} ${i.operands.join(' ')}`);
      return;
    }

    case 'run': {
      const program = flags.demo ? DEFAULT_PROGRAM : JSON.parse(readSource(args._[1]));
      const assembled = engine.assemble(program);
      const result = engine.execute({ name: args._[1] ?? 'program', bytes: assembled.bytes, trace: !!flags.trace });
      if (flags.json) return console.log(JSON.stringify(result, null, 2));
      console.log(`\n\x1b[1mrun\x1b[0m ${result.name} reason=${result.reason} steps=${result.steps} ${result.durationMs}ms`);
      console.log(`  stack: [${result.stack.join(', ')}]`);
      if (result.output.length) console.log(`  output: ${JSON.stringify(result.output)}`);
      if (flags.trace) console.log(`  trace: ${result.steps} steps captured`);
      return;
    }

    case 'snapshot': {
      const out = args._[1] ?? 'b8g.snapshot';
      const snap = engine.snapshot('b8g-engine');
      writeFileSync(out, snap.bytes);
      if (flags.json) return console.log(JSON.stringify(snap.header, null, 2));
      printSnapshotHeader(snap.header);
      console.log(`  written to ${out}`);
      return;
    }

    case 'inspect': {
      const bytes = readBytes(args._[1]);
      const header = inspectSnapshot(bytes);
      if (flags.json) return console.log(JSON.stringify(header, null, 2));
      printSnapshotHeader(header);
      return;
    }

    case 'demo':
      return runDemo(engine, flags);

    default:
      console.error(`unknown command: ${command}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

function readBytes(path) {
  if (!path) throw new Error('this command needs a file path');
  const buf = readFileSync(path);
  // Support base64-encoded .b64 images as well as raw binaries.
  if (path.endsWith('.b64')) return Uint8Array.from(Buffer.from(buf.toString('utf8').trim(), 'base64'));
  return new Uint8Array(buf);
}

function guessLanguage(path) {
  if (!path) return null;
  if (path.endsWith('.c')) return 'c';
  if (path.endsWith('.cpp') || path.endsWith('.cc')) return 'cpp';
  if (path.endsWith('.rs')) return 'rust';
  if (path.endsWith('.ts')) return 'typescript';
  if (path.endsWith('.java')) return 'java';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'ecmascript';
  return null;
}

function runDemo(engine, flags) {
  const source = flags.source ? readFileSync(flags.source, 'utf8') : DEFAULT_SOURCE;
  const language = flags.lang ?? 'ecmascript';

  console.log('\x1b[1m=== b8g demo ===\x1b[0m');
  console.log('\n[1/5] compile through the universal compiler feedback interface');
  const report = engine.compile({ name: 'demo-unit', language, source });
  printFeedback(report);

  console.log('\n[2/5] audit the unit against the capability security model');
  const audit = engine.audit({ name: 'demo-unit', language, source });
  console.log(`  riskScore=${audit.riskScore}`);
  for (const f of audit.findings) console.log(`  ${color(f.severity, `[${f.severity}]`)} ${f.rule} x${f.count}`);

  console.log('\n[3/5] assemble a binary stack program');
  const assembled = engine.assemble(DEFAULT_PROGRAM);
  console.log(`  ${assembled.bytes.length} bytes, ${assembled.instructions.length} instructions`);
  for (const i of assembled.instructions) console.log(`    ${String(i.pc).padStart(4)}  ${i.name} ${i.operands.join(' ')}`);

  console.log('\n[4/5] execute it inside the capability-isolated runner component');
  const result = engine.execute({ name: 'demo.stack', bytes: assembled.bytes });
  console.log(`  reason=${result.reason} steps=${result.steps} stack=[${result.stack.join(', ')}]`);

  console.log('\n[5/5] snapshot the whole engine state');
  const snap = engine.snapshot('demo');
  printSnapshotHeader(snap.header);

  console.log('\n\x1b[1mdone.\x1b[0m');
  void OpName;
}

main().catch((err) => {
  console.error(`\x1b[31mb8g error:\x1b[0m ${err.message}`);
  if (process.env.B8G_DEBUG) console.error(err.stack);
  process.exitCode = 1;
});
