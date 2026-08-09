/**
 * Blackbar editor.
 *
 * Three ideas do most of the work here:
 *
 * 1. SAFE BY DEFAULT. Findings arrive already blacked out. You reveal what
 *    you want seen instead of hiding what you don't. Every other tool makes
 *    the risky state the default state, which is how people leak keys at
 *    3pm on a Tuesday.
 *
 * 2. BLACK BARS ARE THE ONLY REDACTION. Blur and pixelation are here because
 *    people ask for them, but they are effects, not protection — pixelated
 *    text has been recovered by brute-force re-rendering for years, and the
 *    safety readout refuses to count them. Saying so out loud costs us a
 *    feature bullet and buys the thing the whole product is selling.
 *
 * 3. EXPORT IS A FLATTEN. Ops never travel with the file. The exported
 *    bitmap is re-rasterised from scratch, so a black bar is destroyed
 *    pixels, not a layer someone can peel off — and canvas re-encoding
 *    drops every scrap of metadata on the way out.
 */

import { takeCapture } from '../lib/db.js';
import { DEFAULT_AUTO, SEVERITY } from '../lib/detectors.js';
import { verifyOffline } from '../lib/offline-check.js';
import { getLicense, activate } from '../lib/license.js';

/**
 * Pro is switched off for v1.
 *
 * There is no signing key in this build yet, so every licence would be
 * rejected — and a dead Activate button is worse than no button at all.
 * More to the point, what people will pay for is still a guess. Ship free,
 * read the reviews, then build the paid tier around whatever they keep
 * asking for.
 *
 * To turn it on later:
 *   1. node tools/keygen.mjs
 *   2. paste the printed public key into lib/license.js
 *   3. set PRO_ENABLED = true
 */
const PRO_ENABLED = false;

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: false });

const state = {
  base: null,          // full captured bitmap, native pixels
  crop: null,          // { x, y, w, h } in base space
  findings: [],
  unreadable: [],
  ops: [],
  history: [],
  future: [],
  tool: 'redact',
  drag: null,
  pro: false,
  watermark: true,
  pasted: false,
  moving: null,        // label currently being dragged
  selectedText: null,  // label the arrow keys will nudge
  editing: null,       // label currently open in the inline input
};

/* ================================================================ */
/* Load                                                             */
/* ================================================================ */

init().catch((err) => {
  console.error(err);
  $('loading').innerHTML = `<p>${escapeHtml(String(err.message || err))}</p>`;
});

async function init() {
  const license = await getLicense();
  // With Pro switched off, everyone gets everything and nothing nags them.
  state.pro = PRO_ENABLED ? license.plan === 'pro' : true;
  if (PRO_ENABLED && !state.pro) $('upsell').hidden = false;
  state.watermark = PRO_ENABLED && !state.pro;
  $('watermark').checked = state.watermark;
  if (!PRO_ENABLED) $('watermarkRow').hidden = false;

  wire();
  acceptDroppedImages();
  runOfflineSelfTest();

  // Opened with no capture — Chrome blocks extensions on chrome:// pages, so
  // this doubles as the escape hatch: take the shot with the system key and
  // paste it in here.
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return showDropState();

  const cap = await takeCapture(id);
  if (!cap) return showDropState('That capture was already opened. Paste an image to edit it here.');

  state.base = await compose(cap);
  state.crop = cap.crop && cap.crop.w > 4
    ? clampRect(cap.crop, state.base.width, state.base.height)
    : { x: 0, y: 0, w: state.base.width, h: state.base.height };

  state.findings = (cap.findings || []).map((f) => ({ ...f, covered: false }));
  state.unreadable = cap.unreadable || [];
  $('source').textContent = cap.source || '';

  autoRedact();
  sizeCanvas();
  render();
  $('app').dataset.loading = 'false';
}

function runOfflineSelfTest() {
  verifyOffline().then((ok) => {
    const chip = $('chip');
    chip.dataset.verified = String(ok);
    chip.textContent = ok ? 'offline · verified' : 'offline · unverified';
    chip.title = ok
      ? 'Checked just now: Blackbar tried to open a network connection and its own security policy refused. Your image is in this tab and nowhere else.'
      : 'Network self-test did not return the expected result. Please report this.';
  });
}

function showDropState(message) {
  $('app').dataset.loading = 'false';
  $('app').dataset.empty = 'true';
  $('dropzone').hidden = false;
  if (message) $('dropNote').textContent = message;
}

/**
 * Adopt an image from the clipboard or a dropped file.
 *
 * There's no page behind it, so there's nothing to scan — and the ledger says
 * so rather than showing a reassuring "0 found" that means nothing.
 */
async function adoptImage(blob, label) {
  if (!blob || !blob.type.startsWith('image/')) return false;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();

  state.base = c;
  state.crop = { x: 0, y: 0, w: c.width, h: c.height };
  state.findings = [];
  state.unreadable = [];
  state.ops = [];
  state.history = [];
  state.future = [];
  state.pasted = true;

  $('source').textContent = label;
  $('dropzone').hidden = true;
  $('app').dataset.empty = 'false';
  $('app').dataset.loading = 'false';

  commit({ silent: true });
  sizeCanvas();
  render();
  toast('Image loaded. Drag to draw black bars over anything sensitive.');
  return true;
}

function acceptDroppedImages() {
  document.addEventListener('paste', async (e) => {
    for (const item of e.clipboardData?.items || []) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        await adoptImage(item.getAsFile(), 'pasted from clipboard');
        return;
      }
    }
  });

  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  document.addEventListener('dragover', (e) => { stop(e); $('app').dataset.dragging = 'true'; });
  document.addEventListener('dragleave', (e) => { stop(e); $('app').dataset.dragging = 'false'; });
  document.addEventListener('drop', async (e) => {
    stop(e);
    $('app').dataset.dragging = 'false';
    const file = e.dataTransfer?.files?.[0];
    if (file) await adoptImage(file, file.name.slice(0, 60));
  });
}

/** Paint capture tiles onto one bitmap. Single-shot captures are just one tile. */
async function compose(cap) {
  const out = document.createElement('canvas');
  out.width = Math.max(1, cap.width);
  out.height = Math.max(1, cap.height);
  const octx = out.getContext('2d');

  for (const tile of cap.tiles) {
    const bmp = await createImageBitmap(tile.blob);
    octx.drawImage(bmp, tile.x, tile.y);
    bmp.close();
  }
  return out;
}

/* ================================================================ */
/* Findings and coverage                                            */
/* ================================================================ */

function autoRedact() {
  for (const f of state.findings) {
    if (DEFAULT_AUTO.has(f.severity)) coverFinding(f, true);
  }
  commit({ silent: true });
}

function coverFinding(finding, on) {
  const pad = 2;
  if (on) {
    if (finding.covered) return;
    state.ops.push({
      kind: 'redact',
      findingId: finding.id,
      x: finding.x - pad, y: finding.y - pad,
      w: finding.w + pad * 2, h: finding.h + pad * 2,
    });
    finding.covered = true;
  } else {
    state.ops = state.ops.filter((op) => op.findingId !== finding.id);
    finding.covered = false;
  }
}

/** Manual bars count too: a finding is safe if any black bar swallows it. */
function recomputeCoverage() {
  const bars = state.ops.filter((op) => op.kind === 'redact').map(norm);
  for (const f of state.findings) {
    f.covered = bars.some((b) => f.x >= b.x - 2 && f.y >= b.y - 2 && f.x + f.w <= b.x + b.w + 2 && f.y + f.h <= b.y + b.h + 2);
  }
}

const RISKY = new Set([SEVERITY.CRITICAL, SEVERITY.HIGH]);
const exposed = () => state.findings.filter((f) => RISKY.has(f.severity) && !f.covered);

/* ================================================================ */
/* Render                                                           */
/* ================================================================ */

/** Footer height in image pixels, or 0 when it's switched off. */
const footerHeight = () => (state.watermark ? Math.max(22, Math.round(state.crop.h * 0.028)) : 0);

function drawFooter(c, width, top, height) {
  if (!height) return;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = '#131210';
  c.fillRect(0, top, width, height);
  c.fillStyle = '#8e8a7e';
  c.font = `${Math.round(height * 0.52)}px ui-monospace, Menlo, Consolas, monospace`;
  c.textBaseline = 'middle';
  c.fillText('Redacted on-device with Blackbar', Math.round(height * 0.45), top + height / 2);
  c.restore();
}

function sizeCanvas() {
  if (!state.base) return;
  canvas.width = state.crop.w;
  canvas.height = state.crop.h + footerHeight();
  canvas.style.width = `${Math.max(240, Math.min(state.crop.w, window.innerWidth - 460))}px`;
}

function render() {
  if (!state.base) return;
  recomputeCoverage();
  const { x, y, w, h } = state.crop;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.base, x, y, w, h, 0, 0, w, h);
  ctx.translate(-x, -y);

  for (const op of state.ops) paintOp(ctx, op);
  if (state.drag) paintOp(ctx, { ...state.drag, preview: true });

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawFooter(ctx, state.crop.w, state.crop.h, footerHeight());
  paintMarkers();
  paintLedger();
}

function paintOp(c, op) {
  const r = norm(op);
  switch (op.kind) {
    case 'redact':
      c.fillStyle = '#000000'; // the reserved colour
      c.fillRect(r.x, r.y, r.w, r.h);
      break;

    case 'pixelate': {
      const block = Math.max(6, Math.round(Math.min(r.w, r.h) / 9));
      const sw = Math.max(1, Math.round(r.w / block));
      const sh = Math.max(1, Math.round(r.h / block));
      const tmp = document.createElement('canvas');
      tmp.width = sw; tmp.height = sh;
      const t = tmp.getContext('2d');
      t.imageSmoothingEnabled = false;
      t.drawImage(state.base, r.x, r.y, r.w, r.h, 0, 0, sw, sh);
      c.save();
      c.imageSmoothingEnabled = false;
      c.drawImage(tmp, 0, 0, sw, sh, r.x, r.y, r.w, r.h);
      c.restore();
      break;
    }

    case 'blur':
      c.save();
      c.beginPath();
      c.rect(r.x, r.y, r.w, r.h);
      c.clip();
      c.filter = `blur(${Math.max(4, Math.round(Math.min(r.w, r.h) / 8))}px)`;
      c.drawImage(state.base, 0, 0);
      c.restore();
      break;

    case 'crop':
      c.save();
      c.setLineDash([7, 5]);
      c.strokeStyle = '#f2c14e';
      c.lineWidth = 2;
      c.strokeRect(r.x, r.y, r.w, r.h);
      c.restore();
      break;

    case 'box':
      c.save();
      c.strokeStyle = '#f2c14e';
      c.lineWidth = 3;
      c.strokeRect(r.x + 1.5, r.y + 1.5, Math.max(1, r.w - 3), Math.max(1, r.h - 3));
      c.restore();
      break;

    case 'highlight':
      c.save();
      c.globalCompositeOperation = 'multiply';
      c.fillStyle = 'rgba(242, 193, 78, 0.55)';
      c.fillRect(r.x, r.y, r.w, r.h);
      c.restore();
      break;

    case 'arrow': {
      c.save();
      c.strokeStyle = '#f2c14e';
      c.fillStyle = '#f2c14e';
      c.lineWidth = 3.5;
      c.lineCap = 'round';
      const { x1, y1, x2, y2 } = op;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.min(22, Math.hypot(x2 - x1, y2 - y1) * 0.34);
      c.beginPath();
      c.moveTo(x1, y1);
      c.lineTo(x2 - Math.cos(angle) * head * 0.7, y2 - Math.sin(angle) * head * 0.7);
      c.stroke();
      c.beginPath();
      c.moveTo(x2, y2);
      c.lineTo(x2 - head * Math.cos(angle - 0.42), y2 - head * Math.sin(angle - 0.42));
      c.lineTo(x2 - head * Math.cos(angle + 0.42), y2 - head * Math.sin(angle + 0.42));
      c.closePath();
      c.fill();
      c.restore();
      break;
    }

    case 'text': {
      if (op === state.editing) break;  // the inline input is showing it instead
      c.save();
      c.font = `600 ${op.size}px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif`;
      c.textBaseline = 'top';
      // A backing plate rather than a stroke halo: annotations land on
      // screenshots of every possible colour, and a halo loses on busy ones.
      const padX = Math.round(op.size * 0.34);
      const padY = Math.round(op.size * 0.20);
      const tw = c.measureText(op.text).width;
      const th = op.size * 1.18;
      c.fillStyle = 'rgba(12,11,10,0.82)';
      c.beginPath();
      c.roundRect(op.x - padX, op.y - padY, tw + padX * 2, th + padY * 2, Math.round(op.size * 0.16));
      c.fill();
      c.fillStyle = '#f2c14e';
      c.fillText(op.text, op.x, op.y);
      if (op === state.selectedText) {
        c.strokeStyle = 'rgba(242,193,78,0.6)';
        c.lineWidth = Math.max(1, op.size * 0.045);
        c.beginPath();
        c.roundRect(op.x - padX, op.y - padY, tw + padX * 2, th + padY * 2, Math.round(op.size * 0.16));
        c.stroke();
      }
      c.restore();
      break;
    }
  }
}

function paintMarkers() {
  const scale = canvas.clientWidth / canvas.width;
  const host = $('markers');
  host.replaceChildren();
  for (const f of state.findings) {
    if (f.covered) continue;
    const el = document.createElement('div');
    el.className = 'marker';
    el.dataset.id = f.id;
    Object.assign(el.style, {
      left: `${(f.x - state.crop.x) * scale}px`,
      top: `${(f.y - state.crop.y) * scale}px`,
      width: `${f.w * scale}px`,
      height: `${f.h * scale}px`,
    });
    host.append(el);
  }
}

/* ================================================================ */
/* Ledger                                                           */
/* ================================================================ */

function paintLedger() {
  const groups = new Map();
  for (const f of state.findings) {
    const g = groups.get(f.ruleId) || { label: f.label, severity: f.severity, items: [] };
    g.items.push(f);
    groups.set(f.ruleId, g);
  }

  $('count').textContent = String(state.findings.length);
  const rows = $('rows');
  rows.replaceChildren();

  if (!groups.size) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = state.pasted
      ? "This image was pasted, so there's no page text to read — Blackbar can't scan raw pixels yet. Drag a black bar over anything sensitive."
      : state.unreadable.length
        ? 'No readable secrets here. Images and canvases below still need your eyes.'
        : 'Nothing sensitive found. Check it yourself anyway — detection is a second pair of eyes, not a guarantee.';
    rows.append(li);
  }

  for (const [ruleId, g] of groups) {
    const on = g.items.every((f) => f.covered);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'row';
    btn.innerHTML = `
      <span class="dot" data-sev="${g.severity}"></span>
      <span class="row-label">${escapeHtml(g.label)}</span>
      <span class="row-count">${g.items.length}</span>
      <span class="row-state" data-on="${on}">${on ? 'hidden' : 'visible'}</span>`;
    btn.addEventListener('click', () => {
      g.items.forEach((f) => coverFinding(f, !on));
      commit();
    });
    btn.addEventListener('mouseenter', () => highlight(ruleId, true));
    btn.addEventListener('mouseleave', () => highlight(ruleId, false));
    li.append(btn);
    rows.append(li);
  }

  const risk = exposed().length;
  $('lede').textContent = risk
    ? `${risk} sensitive ${risk === 1 ? 'item is' : 'items are'} still readable in this image.`
    : 'Everything sensitive is covered. Uncover anything you want to keep.';

  $('safety').textContent = risk ? `${risk} exposed` : 'clear';
  $('safety').dataset.risk = String(risk > 0);
  $('exportSplit').dataset.risk = String(risk > 0);
  $('export').textContent = risk ? 'Save anyway' : 'Save PNG';

  $('dims').textContent = `${state.crop.w} × ${state.crop.h}`;
  $('undo').disabled = state.history.length === 0;
  $('redo').disabled = state.future.length === 0;

  if (state.unreadable.length) {
    $('unread').hidden = false;
    const n = state.unreadable.length;
    $('unreadText').textContent = `${n} ${n === 1 ? 'region is' : 'regions are'} pictures, not text — an image, canvas or embedded frame. Blackbar can't read what's inside, so it won't pretend they're safe.`;
  }
}

function highlight(ruleId, on) {
  const ids = new Set(state.findings.filter((f) => f.ruleId === ruleId).map((f) => f.id));
  for (const el of $('markers').children) {
    if (ids.has(el.dataset.id)) el.dataset.hot = String(on);
  }
}

/* ================================================================ */
/* Interaction                                                      */
/* ================================================================ */

function wire() {
  $('rail').addEventListener('click', (e) => {
    const btn = e.target.closest('.tool[data-tool]');
    if (!btn) return;
    setTool(btn.dataset.tool);
  });

  canvas.addEventListener('pointerdown', onDown);

  canvas.addEventListener('dblclick', (e) => {
    const op = findTextAt(toImage(e));
    if (!op) return;
    e.preventDefault();
    state.moving = null;
    if (state.tool !== 'text') setTool('text');
    state.selectedText = op;
    placeText(null, op);
  });

  canvas.addEventListener('contextmenu', (e) => {
    const op = findTextAt(toImage(e));
    if (!op) return;   // right-click does nothing over redactions, on purpose
    e.preventDefault();
    state.ops = state.ops.filter((o) => o !== op);
    if (state.selectedText === op) state.selectedText = null;
    commit();
    toast('Label deleted. \u2318Z to undo.');
  });
  canvas.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('resize', () => { sizeCanvas(); render(); });

  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('redactAll').addEventListener('click', () => { state.findings.forEach((f) => coverFinding(f, true)); commit(); });
  $('revealAll').addEventListener('click', () => { state.findings.forEach((f) => coverFinding(f, false)); commit(); });
  $('coverUnread').addEventListener('click', () => {
    state.unreadable.forEach((u) => state.ops.push({ kind: 'redact', x: u.x, y: u.y, w: u.w, h: u.h }));
    commit();
  });

  $('copy').addEventListener('click', () => exportImage('clipboard'));
  $('export').addEventListener('click', () => exportImage('image/png'));
  $('exportMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('exportOptions');
    menu.hidden = !menu.hidden;
    $('exportMenu').setAttribute('aria-expanded', String(!menu.hidden));
  });
  $('exportOptions').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-format]');
    if (!btn) return;
    $('exportOptions').hidden = true;
    exportImage(btn.dataset.format);
  });
  document.addEventListener('click', () => {
    $('exportOptions').hidden = true;
    $('exportMenu').setAttribute('aria-expanded', 'false');
  });

  $('watermark').addEventListener('change', (e) => {
    if (!state.pro && !e.target.checked) {
      e.target.checked = true;
      openPro();
      return;
    }
    state.watermark = e.target.checked;
    sizeCanvas();
    render();
  });

  $('upsell').addEventListener('click', openPro);
  $('closeSheet').addEventListener('click', () => $('proSheet').close());
  $('activate').addEventListener('click', onActivate);

  document.addEventListener('keydown', onKey);
}

const TOOL_KEYS = { 1: 'redact', 2: 'pixelate', 3: 'blur', 4: 'box', 5: 'arrow', 6: 'highlight', 7: 'text', 8: 'crop' };

function setTool(tool) {
  commitActiveText();
  if (tool !== 'text') state.selectedText = null;
  state.tool = tool;
  for (const btn of document.querySelectorAll('.tool[data-tool]')) {
    btn.classList.toggle('is-active', btn.dataset.tool === tool);
  }
  canvas.style.cursor = tool === 'text' ? 'text' : 'crosshair';
}

function toImage(e) {
  const rect = canvas.getBoundingClientRect();
  const scale = canvas.width / rect.width;
  return {
    x: Math.round((e.clientX - rect.left) * scale) + state.crop.x,
    y: Math.round((e.clientY - rect.top) * scale) + state.crop.y,
  };
}

function onDown(e) {
  if (e.button !== 0) return;
  const p = toImage(e);
  if (p.y > state.crop.y + state.crop.h) return;  // the footer strip isn't canvas

  if (state.tool === 'text') {
    // Do NOT capture the pointer here, and do stop the default action: the
    // browser moves focus after this handler returns, which was yanking focus
    // straight back off the input and firing its blur handler in the same
    // frame. The box appeared and vanished before it could be typed into.
    e.preventDefault();

    // Land on an existing label and you pick it up; land on empty space and
    // you make a new one.
    const grabbed = findTextAt(p);
    if (grabbed) {
      commitActiveText();
      canvas.setPointerCapture(e.pointerId);
      state.moving = {
        op: grabbed, dx: p.x - grabbed.x, dy: p.y - grabbed.y,
        startX: grabbed.x, startY: grabbed.y,
      };
      state.selectedText = grabbed;
      canvas.style.cursor = 'grabbing';
      render();
      return;
    }
    state.selectedText = null;
    placeText(p);
    return;
  }

  canvas.setPointerCapture(e.pointerId);
  state.drag = state.tool === 'arrow'
    ? { kind: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y }
    : { kind: state.tool, x: p.x, y: p.y, w: 0, h: 0 };
}

function onMove(e) {
  if (state.moving) {
    const p = toImage(e);
    state.moving.op.x = p.x - state.moving.dx;
    state.moving.op.y = p.y - state.moving.dy;
    render();
    return;
  }
  if (!state.drag) {
    if (state.tool === 'text') {
      canvas.style.cursor = findTextAt(toImage(e)) ? 'grab' : 'text';
    }
    return;
  }
  const p = toImage(e);
  if (state.drag.kind === 'arrow') {
    state.drag.x2 = p.x;
    state.drag.y2 = p.y;
  } else {
    state.drag.w = p.x - state.drag.x;
    state.drag.h = p.y - state.drag.y;
  }
  render();
}

function onUp() {
  if (state.moving) {
    const { op, startX, startY } = state.moving;
    state.moving = null;
    canvas.style.cursor = 'grab';
    if (op.x !== startX || op.y !== startY) commit(); else render();
    return;
  }
  const op = state.drag;
  state.drag = null;
  if (!op) return;

  const tiny = op.kind === 'arrow'
    ? Math.hypot(op.x2 - op.x1, op.y2 - op.y1) < 10
    : Math.abs(op.w) < 6 || Math.abs(op.h) < 6;
  if (tiny) { render(); return; }

  if (op.kind === 'crop') {
    const r = clampRect(norm(op), state.base.width, state.base.height);
    if (r.w > 16 && r.h > 16) {
      state.crop = r;
      sizeCanvas();
      setTool('redact');
    }
  } else {
    state.ops.push(op);
  }
  commit();
}

/**
 * The plate rectangle for a label, in image space. Used for both drawing and
 * hit testing, so what you can grab is exactly what you can see.
 */
function textBounds(op) {
  ctx.save();
  ctx.font = `600 ${op.size}px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const w = ctx.measureText(op.text).width;
  ctx.restore();
  const padX = Math.round(op.size * 0.34);
  const padY = Math.round(op.size * 0.20);
  return { x: op.x - padX, y: op.y - padY, w: w + padX * 2, h: op.size * 1.18 + padY * 2 };
}

/** Topmost label under a point — later ops are drawn on top, so search backwards. */
function findTextAt(p) {
  for (let i = state.ops.length - 1; i >= 0; i--) {
    const op = state.ops[i];
    if (op.kind !== 'text') continue;
    const b = textBounds(op);
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return op;
  }
  return null;
}

/** Font size scales with the image, so a label reads the same on any capture. */
const textSize = () => Math.max(16, Math.round(canvas.width / 46));

let activeInput = null;

/**
 * Place a text label.
 *
 * The input is sized and positioned to sit exactly where the text will render,
 * so what you type is what you get. Previously it was a fixed 14px box while
 * the committed text scaled with the image — on a 1920px capture you typed
 * something small and got something 40px tall somewhere else.
 */
function placeText(p, existing) {
  commitActiveText();

  const rect = canvas.getBoundingClientRect();
  const scale = rect.width / canvas.width;
  const size = existing ? existing.size : textSize();
  if (existing) { p = { x: existing.x, y: existing.y }; state.editing = existing; render(); }
  const PAD_X = 4, PAD_Y = 2, BORDER = 1;

  const input = document.createElement('input');
  input.className = 'floating-text';
  input.placeholder = 'Type, then Enter';
  input.value = existing ? existing.text : '';
  input.spellcheck = false;
  Object.assign(input.style, {
    position: 'fixed',
    left: `${rect.left + (p.x - state.crop.x) * scale - PAD_X - BORDER}px`,
    top: `${rect.top + (p.y - state.crop.y) * scale - PAD_Y - BORDER}px`,
    zIndex: 60,
    padding: `${PAD_Y}px ${PAD_X}px`,
    background: 'rgba(19,18,16,0.92)',
    color: '#f2c14e',
    border: `${BORDER}px solid #3a362e`,
    borderRadius: '3px',
    outline: 'none',
    font: `600 ${Math.max(12, size * scale)}px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif`,
    minWidth: '150px',
    caretColor: '#f2c14e',
  });
  document.body.append(input);

  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    activeInput = null;
    const text = input.value.trim();
    input.remove();
    state.editing = null;

    if (existing) {
      // Editing: empty text deletes the label, anything else replaces it.
      if (!keep) { render(); return; }
      if (!text) state.ops = state.ops.filter((o) => o !== existing);
      else existing.text = text;
      state.selectedText = text ? existing : null;
      commit();
      return;
    }

    if (!keep || !text) { render(); return; }
    const op = { kind: 'text', text, x: p.x, y: p.y, size };
    state.ops.push(op);
    state.selectedText = op;
    commit();
  };

  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') finish(true);
    if (ev.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));

  activeInput = { finish };
  // Focus on the next frame: during pointerdown the browser is still deciding
  // where focus belongs, and focusing now would simply be overridden.
  requestAnimationFrame(() => input.focus());
}

function commitActiveText() {
  activeInput?.finish(true);
}

function onKey(e) {
  if (e.target.matches('input, textarea')) return;
  const meta = e.metaKey || e.ctrlKey;

  if (meta && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (meta && e.key === 'Enter') { e.preventDefault(); exportImage('image/png'); return; }
  if (meta && e.key.toLowerCase() === 'c') { e.preventDefault(); exportImage('clipboard'); return; }
  const NUDGE = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (state.selectedText && NUDGE[e.key]) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const [dx, dy] = NUDGE[e.key];
    state.selectedText.x += dx * step;
    state.selectedText.y += dy * step;
    render();
    return;
  }
  if (TOOL_KEYS[e.key]) { setTool(TOOL_KEYS[e.key]); return; }
  if (e.key.toLowerCase() === 'r') { state.findings.forEach((f) => coverFinding(f, true)); commit(); }
  if (e.key === 'Escape') { state.drag = null; render(); }
}

/* ---- history ---- */

function commit({ silent } = {}) {
  state.history.push(JSON.stringify({ ops: state.ops, crop: state.crop }));
  if (state.history.length > 60) state.history.shift();
  state.future.length = 0;
  if (!silent) render();
}

function restore(snapshot) {
  const parsed = JSON.parse(snapshot);
  state.ops = parsed.ops;
  state.crop = parsed.crop;
  sizeCanvas();
  render();
}

function undo() {
  if (state.history.length < 2) return;
  state.future.push(state.history.pop());
  restore(state.history[state.history.length - 1]);
}

function redo() {
  const next = state.future.pop();
  if (!next) return;
  state.history.push(next);
  restore(next);
}

/* ================================================================ */
/* Export                                                           */
/* ================================================================ */

async function exportImage(format) {
  commitActiveText();
  if (!state.base) { toast('Nothing to save yet — paste or capture an image first.'); return; }

  // The selection ring is editor chrome, not annotation. It must never reach
  // the file — the same mistake as drawing progress into the page.
  const selected = state.selectedText;
  state.selectedText = null;
  try {
    await renderExport(format);
  } finally {
    state.selectedText = selected;
    render();
  }
}

async function renderExport(format) {
  const out = document.createElement('canvas');
  const footer = footerHeight();
  out.width = state.crop.w;
  out.height = state.crop.h + footer;
  const c = out.getContext('2d');

  // Re-rasterise from the original bitmap. Nothing here is a layer.
  c.drawImage(state.base, state.crop.x, state.crop.y, state.crop.w, state.crop.h, 0, 0, state.crop.w, state.crop.h);
  c.translate(-state.crop.x, -state.crop.y);
  for (const op of state.ops) paintOp(c, op);
  c.setTransform(1, 0, 0, 1, 0, 0);

  drawFooter(c, out.width, state.crop.h, footer);

  const type = format === 'clipboard' ? 'image/png' : format;
  const blob = await new Promise((res) => out.toBlob(res, type, type === 'image/jpeg' ? 0.92 : undefined));

  if (format === 'clipboard') {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Copied. Metadata stripped, redactions baked in.');
    } catch {
      toast("Chrome wouldn't allow the copy. Click the image first, then try again.");
    }
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `blackbar-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.${type === 'image/jpeg' ? 'jpg' : 'png'}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Saved. Redactions are burned into the pixels.');
}

/* ================================================================ */
/* Pro                                                              */
/* ================================================================ */

function openPro() {
  $('proSheet').showModal();
  $('licenseInput').focus();
}

async function onActivate() {
  const note = $('licenseNote');
  const result = await activate($('licenseInput').value);
  note.dataset.ok = String(result.valid);
  if (result.valid) {
    state.pro = true;
    $('upsell').hidden = true;
    note.textContent = 'Activated. Thank you — that paid for the next feature.';
    setTimeout(() => $('proSheet').close(), 1200);
  } else {
    note.textContent = result.reason || 'That key was not accepted.';
  }
}

/* ================================================================ */
/* Utilities                                                        */
/* ================================================================ */

function norm(r) {
  return {
    x: r.w < 0 ? r.x + r.w : r.x,
    y: r.h < 0 ? r.y + r.h : r.y,
    w: Math.abs(r.w || 0),
    h: Math.abs(r.h || 0),
  };
}

function clampRect(r, maxW, maxH) {
  const x = Math.max(0, Math.min(r.x, maxW));
  const y = Math.max(0, Math.min(r.y, maxH));
  return { x, y, w: Math.min(r.w, maxW - x), h: Math.min(r.h, maxH - y) };
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
