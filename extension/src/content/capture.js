/**
 * Blackbar in-page capture + scanner.
 *
 * The interesting part is scanDom(). Every other screenshot redactor OCRs the
 * finished bitmap: slow (seconds), lossy (OCR misreads `l` as `1`, which is
 * fatal when the thing you're hiding is an API key), and it needs a ~12 MB
 * WASM payload.
 *
 * Inside a browser we already have the text — and its exact geometry. Reading
 * it out of the DOM with Range.getClientRects() is ~20 ms, character-accurate,
 * and free. OCR stays in the box as a fallback for pixels the DOM can't
 * explain: <img>, <canvas>, <video>, cross-origin iframes. Those get reported
 * as "unreadable regions" instead of being silently ignored, because quietly
 * missing something is the one failure this product can't afford.
 */

(() => {
  if (window.__blackbarLoaded) return;
  window.__blackbarLoaded = true;

  let mod = null; // lazily imported detectors (content scripts aren't modules)
  let overlay = null;
  let cleanupFns = [];

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== 'BB_BEGIN') return;
    begin(msg.mode).catch((err) => console.error('[Blackbar]', err));
    sendResponse({ ok: true });
    return true;
  });

  async function detectors() {
    if (!mod) mod = await import(chrome.runtime.getURL('src/lib/detectors.js'));
    return mod;
  }

  /* -------------------------------------------------------------- */
  /* Modes                                                           */
  /* -------------------------------------------------------------- */

  async function begin(mode) {
    teardown();
    if (mode === 'visible') return captureViewport();
    if (mode === 'fullpage') return capturePage();
    if (mode === 'area') return pickArea();
    if (mode === 'element') return pickElement();
  }

  /** Chrome captures the whole viewport; a selection is a crop of that bitmap. */
  const viewportRegion = () => ({ x: scrollX, y: scrollY, w: innerWidth, h: innerHeight });

  async function captureViewport() {
    await send('BB_FINISH', await meta(viewportRegion()));
  }

  async function pickArea() {
    const ui = buildOverlay('Drag to select · Esc to cancel');
    let start = null, rect = null;
    const box = ui.box;

    const onDown = (e) => { start = { x: e.clientX, y: e.clientY }; ui.showBox(true); };
    const onMove = (e) => {
      ui.hint.style.transform = `translate(${e.clientX + 16}px, ${e.clientY + 16}px)`;
      if (!start) return;
      rect = {
        x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY),
        w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y),
      };
      Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
      ui.size.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;
    };
    const onUp = async () => {
      if (!rect || rect.w < 8 || rect.h < 8) { teardown(); return; }
      const payload = await meta(viewportRegion());
      payload.crop = { x: Math.round(rect.x * devicePixelRatio), y: Math.round(rect.y * devicePixelRatio), w: Math.round(rect.w * devicePixelRatio), h: Math.round(rect.h * devicePixelRatio) };
      teardown();
      await afterPaint();
      await send('BB_FINISH', payload);
    };

    listen(document, 'mousedown', onDown, true);
    listen(document, 'mousemove', onMove, true);
    listen(document, 'mouseup', onUp, true);
    listen(document, 'keydown', (e) => { if (e.key === 'Escape') { teardown(); send('BB_CANCEL', {}); } }, true);
  }

  async function pickElement() {
    const ui = buildOverlay('Click an element · Esc to cancel');
    ui.showBox(true);
    let target = null;

    const onMove = (e) => {
      overlay.style.pointerEvents = 'none';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      overlay.style.pointerEvents = '';
      if (!el || el === target) return;
      target = el;
      const r = el.getBoundingClientRect();
      Object.assign(ui.box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      ui.size.textContent = `${el.tagName.toLowerCase()} · ${Math.round(r.width)} × ${Math.round(r.height)}`;
      ui.hint.style.transform = `translate(${e.clientX + 16}px, ${e.clientY + 16}px)`;
    };
    const onClick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!target) return;
      const r = target.getBoundingClientRect();
      const payload = await meta(viewportRegion());
      payload.crop = { x: Math.round(r.left * devicePixelRatio), y: Math.round(r.top * devicePixelRatio), w: Math.round(r.width * devicePixelRatio), h: Math.round(r.height * devicePixelRatio) };
      teardown();
      await afterPaint();
      await send('BB_FINISH', payload);
    };

    listen(document, 'mousemove', onMove, true);
    listen(document, 'click', onClick, true);
    listen(document, 'keydown', (e) => { if (e.key === 'Escape') { teardown(); send('BB_CANCEL', {}); } }, true);
  }

  async function capturePage() {
    const doc = document.documentElement;
    const pageW = Math.min(doc.scrollWidth, 8192);
    const pageH = Math.min(doc.scrollHeight, 16384);
    const vw = innerWidth, vh = innerHeight;
    const origin = { x: scrollX, y: scrollY };
    const prevBehavior = doc.style.scrollBehavior;
    doc.style.scrollBehavior = 'auto';

    const region = { x: 0, y: 0, w: pageW, h: pageH };
    const payload = await meta(region); // scan once, before anything moves

    const fixed = collectFixed();
    let tile = 0;
    const cols = Math.ceil(pageW / vw), rows = Math.ceil(pageH / vh);

    try {
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = Math.min(col * vw, Math.max(0, pageW - vw));
          const y = Math.min(row * vh, Math.max(0, pageH - vh));
          scrollTo(x, y);
          await afterPaint();
          if (tile === 1) fixed.forEach((el) => { el.dataset.bbFixed = el.style.visibility; el.style.visibility = 'hidden'; });
          await send('BB_CAPTURE_TILE', {
            x: Math.round(scrollX * devicePixelRatio),
            y: Math.round(scrollY * devicePixelRatio),
            total: rows * cols,
          });
          tile++;
        }
      }
    } finally {
      fixed.forEach((el) => { el.style.visibility = el.dataset.bbFixed || ''; delete el.dataset.bbFixed; });
      scrollTo(origin.x, origin.y);
      doc.style.scrollBehavior = prevBehavior;
    }

    payload.width = Math.round(pageW * devicePixelRatio);
    payload.height = Math.round(pageH * devicePixelRatio);
    payload.stitched = true;
    await send('BB_FINISH', payload);
  }

  /* -------------------------------------------------------------- */
  /* Scanning                                                        */
  /* -------------------------------------------------------------- */

  async function meta(region) {
    const scan = await scanDom(region);
    return {
      dpr: devicePixelRatio,
      width: Math.round(region.w * devicePixelRatio),
      height: Math.round(region.h * devicePixelRatio),
      source: `${location.hostname}${location.pathname}`.slice(0, 80),
      findings: scan.findings,
      unreadable: scan.unreadable,
    };
  }

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE']);
  const OPAQUE_TAGS = 'img,canvas,video,svg,iframe,embed,object';

  async function scanDom(region) {
    const { scanText, SEVERITY } = await detectors();
    const dpr = devicePixelRatio;
    const findings = [];
    const unreadable = [];
    const toLocal = (r) => ({
      x: Math.round((r.left + scrollX - region.x) * dpr),
      y: Math.round((r.top + scrollY - region.y) * dpr),
      w: Math.round(r.width * dpr),
      h: Math.round(r.height * dpr),
    });
    const inRegion = (b) => b.x + b.w > 0 && b.y + b.h > 0 && b.x < region.w * dpr && b.y < region.h * dpr && b.w > 0 && b.h > 0;

    // 1. Text nodes — exact character geometry.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.trim().length < 4) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p || SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node, budget = 20000;
    while ((node = walker.nextNode()) && budget-- > 0) {
      const hits = scanText(node.nodeValue);
      if (!hits.length) continue;
      const style = getComputedStyle(node.parentElement);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;

      for (const hit of hits) {
        const range = document.createRange();
        try {
          range.setStart(node, hit.start);
          range.setEnd(node, hit.end);
        } catch { continue; }
        for (const r of range.getClientRects()) {
          const box = toLocal(r);
          if (!inRegion(box)) continue;
          findings.push({ ...box, id: uid(), ruleId: hit.ruleId, label: hit.label, severity: hit.severity, source: 'dom' });
        }
      }
    }

    // 2. Form fields — value text isn't in a text node.
    for (const el of document.querySelectorAll('input, textarea')) {
      const r = el.getBoundingClientRect();
      const box = toLocal(r);
      if (!inRegion(box) || box.w < 8) continue;
      if (el.type === 'password' && el.value) {
        findings.push({ ...box, id: uid(), ruleId: 'password_field', label: 'Password field', severity: SEVERITY.CRITICAL, source: 'dom' });
        continue;
      }
      const hits = scanText(el.value || '');
      if (hits.length) {
        const worst = hits[0];
        findings.push({ ...box, id: uid(), ruleId: worst.ruleId, label: worst.label, severity: worst.severity, source: 'dom' });
      }
    }

    // 3. Same-origin frames. Chrome lets us read these without any extra
    //    permission, so scan them rather than writing them off as opaque.
    //    Cross-origin frames (Office 365, Google Docs, embedded viewers) throw
    //    on access and fall through to step 4, where they're reported honestly.
    const openFrames = new Set();
    for (const frame of document.querySelectorAll('iframe,frame')) {
      let inner;
      try {
        inner = frame.contentDocument;
        if (!inner || !inner.body) continue;
      } catch {
        continue; // cross-origin: not ours to read
      }
      openFrames.add(frame);
      const fr = frame.getBoundingClientRect();
      for (const hit of scanDocument(inner)) {
        const box = {
          x: Math.round((fr.left + hit.left + scrollX - region.x) * dpr),
          y: Math.round((fr.top + hit.top + scrollY - region.y) * dpr),
          w: Math.round(hit.width * dpr),
          h: Math.round(hit.height * dpr),
        };
        if (!inRegion(box)) continue;
        findings.push({ ...box, id: uid(), ruleId: hit.ruleId, label: hit.label, severity: hit.severity, source: 'frame' });
      }
    }

    // 4. Pixels we can't read. Reported, never assumed safe.
    for (const el of document.querySelectorAll(OPAQUE_TAGS)) {
      if (openFrames.has(el)) continue; // already scanned above
      const r = el.getBoundingClientRect();
      const box = toLocal(r);
      if (!inRegion(box) || box.w * box.h < 64 * 64 * dpr * dpr) continue;
      const area = box.w * box.h;
      unreadable.push({
        ...box, id: uid(), tag: el.tagName.toLowerCase(),
        // A region covering most of the capture means the real content is
        // somewhere Blackbar can't see. The editor says so loudly.
        dominant: area > region.w * region.h * dpr * dpr * 0.5,
      });
    }

    return { findings: dedupe(findings), unreadable: unreadable.slice(0, 40) };
  }

  /**
   * Walk one document's text nodes and return matches with their local
   * geometry. Used for the top document and for any same-origin frame.
   */
  function scanDocument(doc) {
    const out = [];
    if (!doc?.body) return out;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.trim().length < 4) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node, budget = 8000;
    while ((node = walker.nextNode()) && budget-- > 0) {
      const hits = mod.scanText(node.nodeValue);
      if (!hits.length) continue;
      for (const hit of hits) {
        const range = doc.createRange();
        try {
          range.setStart(node, hit.start);
          range.setEnd(node, hit.end);
        } catch { continue; }
        for (const r of range.getClientRects()) {
          out.push({ ...hit, left: r.left, top: r.top, width: r.width, height: r.height });
        }
      }
    }
    return out;
  }

  function dedupe(list) {
    const seen = new Set();
    return list.filter((f) => {
      const key = `${f.ruleId}:${f.x}:${f.y}:${f.w}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const uid = () => Math.random().toString(36).slice(2, 10);

  /* -------------------------------------------------------------- */
  /* Overlay UI                                                      */
  /* -------------------------------------------------------------- */

  /**
   * The selection overlay, built inside a shadow root.
   *
   * It used to be a plain div styled by an injected stylesheet, and it could
   * fail to appear for at least four different reasons: insertCSS not landing,
   * the host page's own CSS reaching the children, `all: initial` wiping
   * properties the later rules assumed, and the hidden attribute losing a
   * specificity fight. None of those are debuggable from a user's bug report.
   *
   * A closed shadow root plus inline !important host styles removes the whole
   * class of problem — page CSS cannot reach inside a shadow root, and inline
   * !important cannot be outranked. It also drops the separate CSS injection
   * step, so there is one less await between the shortcut and the overlay.
   */
  const OVERLAY_STYLE = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .scrim { position: fixed; inset: 0; background: rgba(12,11,10,.42); }
    .box {
      position: fixed; display: none;
      border: 1px solid #f2c14e;
      box-shadow: 0 0 0 9999px rgba(12,11,10,.42);
      pointer-events: none;
    }
    .box.on { display: block; }
    .box::before, .box::after {
      content: ""; position: absolute; width: 9px; height: 9px; border: 1px solid #f2c14e;
    }
    .box::before { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
    .box::after { right: -1px; bottom: -1px; border-left: 0; border-top: 0; }
    .size {
      position: absolute; top: 100%; left: 0; margin-top: 6px; padding: 3px 7px;
      border-radius: 3px; background: #1c1b19; color: #ede9e0; white-space: nowrap;
      font: 11px ui-monospace, Menlo, Consolas, monospace; letter-spacing: .04em;
    }
    .hint {
      position: fixed; top: 0; left: 0; display: flex; align-items: center; gap: 7px;
      padding: 7px 11px; border: 1px solid #3a362e; border-radius: 6px;
      background: #1c1b19; color: #ede9e0; white-space: nowrap; pointer-events: none;
      font: 12.5px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,.4);
    }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #f2c14e; }
  `;

  function buildOverlay(hintText) {
    overlay = document.createElement('div');

    // Inline and !important: nothing in the host page can outrank this.
    const s = overlay.style;
    for (const [prop, value] of Object.entries({
      position: 'fixed', inset: '0', display: 'block', margin: '0', padding: '0',
      border: '0', background: 'transparent', 'pointer-events': 'auto',
      cursor: 'crosshair', 'z-index': '2147483647', opacity: '1',
      visibility: 'visible', transform: 'none', filter: 'none', 'clip-path': 'none',
    })) s.setProperty(prop, value, 'important');

    const root = overlay.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>${OVERLAY_STYLE}</style>
      <div class="scrim"></div>
      <div class="box"><span class="size"></span></div>
      <div class="hint"><span class="dot"></span>${escapeText(hintText)}</div>`;

    (document.body || document.documentElement).appendChild(overlay);

    const box = root.querySelector('.box');
    return {
      box,
      hint: root.querySelector('.hint'),
      size: root.querySelector('.size'),
      showBox: (on) => box.classList.toggle('on', on),
    };
  }

  const escapeText = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function collectFixed() {
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') out.push(el);
      if (out.length > 60) break;
    }
    return out;
  }

  /* -------------------------------------------------------------- */

  function listen(target, type, fn, capture) {
    target.addEventListener(type, fn, capture);
    cleanupFns.push(() => target.removeEventListener(type, fn, capture));
  }

  function teardown() {
    cleanupFns.forEach((fn) => fn());
    cleanupFns = [];
    overlay?.remove();
    overlay = null;
  }

  const afterPaint = () =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 90))));

  const send = (type, payload) => chrome.runtime.sendMessage({ type, ...payload });
})();
