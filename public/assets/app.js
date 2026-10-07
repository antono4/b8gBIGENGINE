/* b8g console — talks to the engine over /api, renders telemetry. */

/* The console is a static page. It uses a same-origin engine by default, or a
   remote engine when ?api=https://host:port is supplied (useful when the
   console is hosted on GitHub Pages and the engine runs elsewhere). */
const API_BASE = (() => {
  const q = new URLSearchParams(location.search).get('api');
  return q ? q.replace(/\/$/, '') : '';
})();

const API = (path, opts) => fetch(`${API_BASE}${path}`, opts).then(async (r) => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
});

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html !== undefined) node.innerHTML = html;
  return node;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n) => (n ?? 0).toLocaleString('en-US');
const bytesFmt = (n) => (n > 1024 * 1024 ? `${(n / 1048576).toFixed(2)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

const SAMPLE_SOURCE = `// unit emitted by an AI codegen loop
function sum(values) {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
const unused = 42;
globalThis.cache = sum([1, 2, 3]);
`;

const HAZARD_SOURCE = `// a deliberately hazardous unit
const result = eval("1 + 1");
function loop() { while (true) { /* spin */ } }
const buf = new SharedArrayBuffer(1024);
const child = require("child_process");
fetch("https://example.com/data").then(r => r.text());
globalThis.leak = buf;
`;

const DEFAULT_PROGRAM = JSON.stringify(
  [['PUSH', 6], ['PUSH', 7], ['MUL'], ['PUSH', 2], ['ADD'], ['HALT']],
  null, 1,
);

/* ---------------- navigation ---------------- */
document.querySelectorAll('.rail-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.rail-item').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${btn.dataset.panel}`));
  });
});

/* ---------------- status ---------------- */
let lastStatus = null;

async function refreshStatus() {
  try {
    const status = await API('/api/status');
    lastStatus = status;
    const chip = $('#chip-state');
    chip.className = 'chip ok';
    chip.innerHTML = '<i class="dot"></i>engine online';
    $('#chip-uptime').textContent = `uptime ${(status.uptimeMs / 1000).toFixed(1)}s`;
    $('#chip-clock').textContent = `clock ${num(status.clock)}`;
    $('#chip-mem').textContent = `mem ${bytesFmt(status.memory.bytesAllocated)}`;
    $('#chip-components').textContent = `components ${status.components.length}`;

    $('#m-components').textContent = status.components.length;
    $('#m-regions').textContent = status.memory.regions.length;
    $('#m-alloc').textContent = bytesFmt(status.memory.bytesAllocated);
    $('#m-streams').textContent = status.streams.length;
    $('#m-events').textContent = num(status.events.length);

    renderRegions(status.memory.regions);
    renderEvents(status.events.slice(-60).reverse());
    renderComposition(status);
    renderCapabilities(status);
    renderStreamBar(status);
  } catch (err) {
    const chip = $('#chip-state');
    chip.className = 'chip bad';
    chip.innerHTML = `<i class="dot"></i>offline — ${esc(err.message)}`;
  }
}

function renderRegions(regions) {
  const host = $('#region-list');
  host.innerHTML = '';
  regions.forEach((r) => {
    const row = el('div', 'row');
    row.innerHTML = `
      <span class="k">${esc(r.name)}</span>
      <span class="v">${bytesFmt(r.size)}</span>
      <span class="spacer"></span>
      <span class="tag">${r.shared ? 'shared' : 'private'}</span>
      <span class="tag">r ${r.reads} · w ${r.writes}</span>`;
    host.appendChild(row);
  });
}

function renderEvents(events) {
  const host = $('#event-log');
  $('#event-count').textContent = events.length;
  host.innerHTML = '';
  if (!events.length) return host.appendChild(el('div', 'empty', 'no events yet'));
  events.forEach((e) => {
    const row = el('div', 'event');
    const detail = JSON.stringify(e.detail ?? {}).slice(0, 140);
    row.innerHTML = `<span class="t">${new Date(e.at).toLocaleTimeString('en-GB')}</span>
      <span class="ty">${esc(e.type)}</span><span class="de">${esc(detail)}</span>`;
    host.appendChild(row);
  });
}

function renderComposition(status) {
  const host = $('#composition');
  const kernel = { name: status.name, x: 20, y: 20 };
  const comps = status.components;
  const rowH = 46;
  const width = 900;
  const height = Math.max(160, 60 + comps.length * rowH);
  let svg = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs><marker id="arw" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#7fae2c"/></marker></defs>`;

  svg += `<rect x="${kernel.x}" y="${kernel.y}" width="180" height="40" rx="2" fill="#101216" stroke="#b6ff3d"/>
    <text x="${kernel.x + 14}" y="${kernel.y + 25}" fill="#b6ff3d" font-family="monospace" font-size="13">${esc(kernel.name)} (kernel)</text>`;

  comps.forEach((c, i) => {
    const y = 100 + i * rowH;
    svg += `<line x1="${kernel.x + 90}" y1="${kernel.y + 40}" x2="${kernel.x + 90}" y2="${y}" stroke="#7fae2c" stroke-dasharray="3 3"/>
      <line x1="${kernel.x + 90}" y1="${y}" x2="330" y2="${y}" stroke="#7fae2c" marker-end="url(#arw)"/>
      <rect x="330" y="${y - 16}" width="210" height="32" rx="2" fill="#14171c" stroke="#343a44"/>
      <text x="344" y="${y + 5}" fill="#e8ecef" font-family="monospace" font-size="12">${esc(c.name)}@${esc(c.version)}</text>
      <text x="560" y="${y + 5}" fill="#5d6672" font-family="monospace" font-size="11">${esc(c.requires.join(', '))} → ${esc(c.provides.join(', '))}</text>`;
    Object.entries(c.handles).forEach(([hname, h], hi) => {
      const hx = 640 + hi * 90;
      svg += `<rect x="${hx}" y="${y - 12}" width="84" height="24" rx="12" fill="#0c0e11" stroke="#45d9c8"/>
        <text x="${hx + 8}" y="${y + 4}" fill="#45d9c8" font-family="monospace" font-size="10">${esc(hname)}</text>`;
    });
  });

  svg += '</svg>';
  host.innerHTML = svg;
}

function renderCapabilities(status) {
  const handles = [];
  status.components.forEach((c) => {
    Object.entries(c.handles).forEach(([name, h]) => handles.push({ owner: c.name, name, ...h }));
  });
  const host = $('#handle-table');
  $('#handle-count').textContent = `${handles.length} handles`;
  const rightsList = ['read', 'write', 'exec', 'transfer', 'grant'];
  host.innerHTML = '';
  const head = el('div', 'ht-row head');
  head.innerHTML = '<span>owner</span><span>handle</span><span>target</span><span>rights</span>';
  host.appendChild(head);
  handles.forEach((h) => {
    const row = el('div', 'ht-row');
    const held = (h.rightsText || '').split('|');
    row.innerHTML = `<span class="hn">${esc(h.owner)}</span>
      <span class="htag">${esc(h.name)}</span>
      <span class="htag">${esc(h.tagName)}</span>
      <span class="rights">${rightsList.map((r) => `<span class="right ${held.includes(r) ? 'on' : ''}">${r}</span>`).join('')}</span>`;
    host.appendChild(row);
  });

  const legend = $('#rights-legend');
  legend.innerHTML = `
    <div><b>read</b> — may read region bytes / observe a stream</div>
    <div><b>write</b> — may write bytes / emit events</div>
    <div><b>exec</b> — may invoke a function handle</div>
    <div><b>transfer</b> — may move the handle</div>
    <div><b>grant</b> — may hand the handle to another context</div>`;
}

function renderStreamBar(status) {
  const items = [];
  status.streams.forEach((s) => items.push(`<span><b>${esc(s.name)}</b> ${s.total} events</span>`));
  status.components.forEach((c) => items.push(`<span><b>${esc(c.name)}</b> ${esc(c.status)}</span>`));
  status.memory.regions.forEach((r) => items.push(`<span><b>${esc(r.name)}</b> ${bytesFmt(r.size)}</span>`));
  const track = $('#stream-track');
  const line = items.join('');
  track.innerHTML = line + line;
}

/* ---------------- compiler ---------------- */
async function loadAdapters() {
  const { adapters } = await API('/api/adapters');
  const host = $('#adapter-table');
  $('#adapter-count').textContent = `${adapters.length} adapters`;
  host.innerHTML = '';
  adapters.forEach((a) => {
    const cls = a.available ? (a.feedbackOnly ? 'adapter feedback' : 'adapter available') : 'adapter';
    const row = el('div', cls);
    row.innerHTML = `<span class="an">${esc(a.name)}</span>
      <span><span class="al">${esc(a.languages.join(' · '))}</span><br><span class="ap">${esc(a.passes.join(' → '))}</span></span>
      <span class="tag">${a.available ? (a.feedbackOnly ? 'feedback' : 'live') : 'modelled'}</span>`;
    host.appendChild(row);
  });
}

async function runCompile() {
  const source = $('#source').value;
  const language = $('#lang').value;
  const pipeline = $('#pipeline').value;
  const body = { name: 'console-unit', language, source };
  if (pipeline) body.adapters = pipeline.split(',');

  try {
    const report = await API('/api/compile', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    renderDiagnostics(report);
    renderRemarks(report);
    renderArtifacts(report);
  } catch (err) {
    $('#diag-list').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

function renderDiagnostics(report) {
  const host = $('#diag-list');
  host.innerHTML = '';
  $('#diag-count').textContent = `${report.diagnostics.length} · ${report.summary.errors}E ${report.summary.warnings}W`;
  if (!report.diagnostics.length) return host.appendChild(el('div', 'empty', 'clean — no diagnostics'));
  report.diagnostics.forEach((d) => {
    const row = el('div', 'row');
    row.innerHTML = `<span class="sev ${d.severity}">${d.severity}</span>
      <span class="msg">${esc(d.message)}${d.pass ? `<small>pass: ${esc(d.pass)}${d.hint ? ` — ${esc(d.hint)}` : ''}</small>` : ''}</span>`;
    host.appendChild(row);
  });
}

function renderRemarks(report) {
  const host = $('#remark-list');
  host.innerHTML = '';
  $('#remark-count').textContent = `${report.remarks.length} remarks`;
  if (!report.remarks.length) return host.appendChild(el('div', 'empty', 'no optimisation remarks'));
  report.remarks.forEach((r) => {
    const row = el('div', 'row');
    const impact = r.impact ? `<span class="tag">impact ${r.impact}</span>` : '';
    row.innerHTML = `<span class="sev remark">${esc(r.pass)}</span>
      <span class="msg">${esc(r.message)}${r.suggestion ? `<small>${esc(r.suggestion)}</small>` : ''}</span>${impact}`;
    host.appendChild(row);
  });
}

function renderArtifacts(report) {
  const host = $('#artifact-list');
  host.innerHTML = '';
  if (!report.artifacts.length) return host.appendChild(el('div', 'empty', 'no artifacts emitted'));
  report.artifacts.forEach((a) => {
    const row = el('div', 'row');
    row.innerHTML = `<span class="k">${esc(a.name)}</span><span class="tag">${esc(a.kind)}</span>
      <span class="spacer"></span><span class="num">${bytesFmt(a.size)}</span>`;
    host.appendChild(row);
  });
}

/* ---------------- audit ---------------- */
async function runAudit() {
  const source = $('#audit-source').value;
  try {
    const record = await API('/api/audit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'audited-unit', language: 'ecmascript', source }),
    });
    $('#risk-badge').textContent = `risk ${record.riskScore}`;
    $('#risk-badge').style.color = record.riskScore > 8 ? 'var(--red)' : record.riskScore > 0 ? 'var(--amber)' : 'var(--acid)';
    const host = $('#finding-list');
    host.innerHTML = '';
    $('#finding-count').textContent = `${record.findings.length} findings`;
    if (!record.findings.length) host.appendChild(el('div', 'empty', 'clean — no hazards detected'));
    record.findings.forEach((f) => {
      const row = el('div', 'row');
      row.innerHTML = `<span class="sev ${f.severity}">${f.severity}</span>
        <span class="msg">${esc(f.rule)} <small>x${f.count} — ${esc(f.note)}</small></span>`;
      host.appendChild(row);
    });
    $('#audit-record').textContent = JSON.stringify(record, null, 2);
  } catch (err) {
    $('#audit-record').textContent = `error: ${err.message}`;
  }
}

/* ---------------- stack vm ---------------- */
let lastProgramBytes = null;

async function assembleProgram() {
  const program = JSON.parse($('#program').value);
  const res = await API('/api/assemble', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ program }),
  });
  lastProgramBytes = res.bytes;
  $('#listing-size').textContent = `${res.size} bytes`;
  const host = $('#listing');
  host.innerHTML = '';
  res.instructions.forEach((i) => {
    const row = el('div', 'ins');
    row.innerHTML = `<span class="pc">${String(i.pc).padStart(4, '0')}</span>
      <span class="op">${esc(i.name)}</span><span class="arg">${i.operands.map(esc).join(' ')}</span>`;
    host.appendChild(row);
  });
  return res;
}

async function executeProgram() {
  const trace = $('#trace').checked;
  const body = { name: 'console.stack', trace };
  if (lastProgramBytes) body.bytes = lastProgramBytes;
  else body.program = JSON.parse($('#program').value);
  const res = await API('/api/execute', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  $('#run-reason').textContent = `${res.reason} · ${res.steps} steps · ${res.durationMs}ms`;
  const tape = $('#stack-tape');
  tape.innerHTML = '';
  res.stack.forEach((v) => tape.appendChild(el('div', 'tape-cell', esc(v))));
  $('#run-result').textContent = JSON.stringify(res, null, 2);
}

/* ---------------- snapshot ---------------- */
let snapshotBytes = null;

async function captureSnapshot() {
  const res = await API('/api/snapshot', { method: 'POST' });
  $('#snapshot-header').innerHTML = headerCells(res.header);
  renderByteStrip(res.header);
  renderSectionMap(res.header);
  $('#btn-download').disabled = false;

  const sections = await API('/api/pipeline', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: SAMPLE_SOURCE, language: 'ecmascript' }),
  });
  $('#snapshot-json').textContent = JSON.stringify(
    { snapshot: res.header, engine: lastStatus ? { components: lastStatus.components.map((c) => c.name), streams: lastStatus.streams.map((s) => s.name) } : null, pipeline: sections.summary ?? null },
    null, 2,
  );
}

function headerCells(h) {
  return [
    ['magic', h.magic, ''],
    ['version', h.version, ''],
    ['rehashable', String(h.rehashable), h.rehashable ? 'good' : 'bad'],
    ['contexts', h.contextCount, ''],
    ['payload', bytesFmt(h.payloadLength), ''],
    ['total', bytesFmt(h.totalSize), ''],
    ['checksum', `0x${h.checksum.toString(16)}`, h.checksumValid ? 'good' : 'bad'],
    ['valid', String(h.checksumValid), h.checksumValid ? 'good' : 'bad'],
  ].map(([k, v, cls]) => `<div class="hcell"><div class="hk">${k}</div><div class="hv ${cls}">${esc(v)}</div></div>`).join('');
}

function renderByteStrip(h) {
  const host = $('#byte-strip');
  host.innerHTML = '';
  const total = Math.min(h.totalSize, 320);
  for (let i = 0; i < total; i++) {
    const b = el('div', 'byte');
    const inHeader = i < 128;
    b.style.background = inHeader ? 'var(--acid-dim)' : i % 7 === 0 ? 'var(--cyan)' : 'var(--line)';
    b.title = `offset ${i}`;
    host.appendChild(b);
  }
}

function renderSectionMap(h) {
  const sections = ['readonly', 'memory', 'contexts', 'capabilities', 'components', 'streams', 'meta', 'reserved'];
  const host = $('#section-map');
  host.innerHTML = '';
  sections.forEach((name, i) => {
    const row = el('div', 'row');
    row.innerHTML = `<span class="k">[${String(i).padStart(2, '0')}] ${name}</span>
      <span class="spacer"></span><span class="v">${i === 7 ? '0 B' : 'present'}</span>`;
    host.appendChild(row);
  });
}

async function runPipeline() {
  const btn = $('#btn-demo');
  btn.disabled = true;
  btn.textContent = 'running…';
  try {
    const res = await API('/api/pipeline', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: SAMPLE_SOURCE, language: 'ecmascript', trace: true }),
    });
    // Populate every panel with the pipeline result.
    renderDiagnostics(res.compile);
    renderRemarks(res.compile);
    renderArtifacts(res.compile);
    $('#source').value = SAMPLE_SOURCE;
    $('#audit-source').value = SAMPLE_SOURCE;
    $('#risk-badge').textContent = `risk ${res.audit.riskScore}`;

    const fhost = $('#finding-list');
    fhost.innerHTML = '';
    res.audit.findings.forEach((f) => {
      const row = el('div', 'row');
      row.innerHTML = `<span class="sev ${f.severity}">${f.severity}</span><span class="msg">${esc(f.rule)} <small>x${f.count}</small></span>`;
      fhost.appendChild(row);
    });
    $('#audit-record').textContent = JSON.stringify(res.audit, null, 2);

    $('#listing-size').textContent = `${res.assemble.size} bytes`;
    const lhost = $('#listing');
    lhost.innerHTML = '';
    res.assemble.instructions.forEach((i) => {
      const row = el('div', 'ins');
      row.innerHTML = `<span class="pc">${String(i.pc).padStart(4, '0')}</span><span class="op">${esc(i.name)}</span><span class="arg">${i.operands.map(esc).join(' ')}</span>`;
      lhost.appendChild(row);
    });

    $('#run-reason').textContent = `${res.execute.reason} · ${res.execute.steps} steps`;
    const tape = $('#stack-tape');
    tape.innerHTML = '';
    res.execute.stack.forEach((v) => tape.appendChild(el('div', 'tape-cell', esc(v))));
    $('#run-result').textContent = JSON.stringify(res.execute, null, 2);

    $('#snapshot-header').innerHTML = headerCells(res.snapshot.header);
    renderByteStrip(res.snapshot.header);
    renderSectionMap(res.snapshot.header);
    $('#snapshot-json').textContent = JSON.stringify(res.snapshot, null, 2);
    $('#btn-download').disabled = false;

    await refreshStatus();
  } catch (err) {
    alert(`pipeline failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'run pipeline';
  }
}

/* ---------------- live bus ---------------- */
function connectBus() {
  try {
    const es = new EventSource(`${API_BASE}/api/events`);
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data);
        addLiveEvent(event);
      } catch { /* ignore */ }
    };
  } catch { /* SSE unsupported */ }
}

let liveEvents = [];
function addLiveEvent(event) {
  liveEvents.unshift(event);
  if (liveEvents.length > 60) liveEvents.pop();
  renderEvents(liveEvents);
}

/* ---------------- wire up ---------------- */
function init() {
  $('#source').value = SAMPLE_SOURCE;
  $('#audit-source').value = HAZARD_SOURCE;
  $('#program').value = DEFAULT_PROGRAM;

  $('#btn-refresh').addEventListener('click', refreshStatus);
  $('#btn-demo').addEventListener('click', runPipeline);
  $('#btn-compile').addEventListener('click', runCompile);
  $('#btn-audit').addEventListener('click', runAudit);
  $('#btn-audit-sample').addEventListener('click', () => { $('#audit-source').value = HAZARD_SOURCE; runAudit(); });
  $('#btn-assemble').addEventListener('click', () => assembleProgram().catch((e) => alert(e.message)));
  $('#btn-execute').addEventListener('click', () => executeProgram().catch((e) => alert(e.message)));
  $('#btn-snapshot').addEventListener('click', () => captureSnapshot().catch((e) => alert(e.message)));
  $('#btn-download').addEventListener('click', async () => {
    const res = await API('/api/snapshot', { method: 'POST' });
    const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${res.name}.b8g.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  refreshStatus();
  loadAdapters().catch(() => {});
  connectBus();
  setInterval(refreshStatus, 8000);
}

init();
