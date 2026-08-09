/**
 * Blackbar service worker.
 *
 * Holds no state the user cares about and makes no network calls (the
 * extension CSP sets connect-src 'none', which applies here too).
 *
 * Permission note: capture works on `activeTab`, which Chrome grants only
 * when the user invokes the extension (toolbar click or keyboard shortcut)
 * and revokes on navigation. That is why the install prompt does not ask to
 * "read and change data on all websites" — the single biggest install-rate
 * killer for screenshot extensions, and the claim we most need to keep clean.
 */

import { putCapture, sweep } from './lib/db.js';

const CAPTURE_MIN_INTERVAL = 620; // Chrome caps captureVisibleTab at ~2/sec
let lastCaptureAt = 0;
const jobs = new Map(); // tabId -> { tiles: [], meta }

/* ---------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/editor/welcome.html') });
  }
  sweep(0).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  const mode = { 'capture-area': 'area', 'capture-visible': 'visible', 'capture-fullpage': 'fullpage' }[command];
  if (!mode || !tab?.id) return;
  try {
    await start(tab, mode);
  } catch (err) {
    // There's no popup open on the shortcut path, so an uncaught rejection here
    // is invisible. Put it on the badge instead of losing it.
    console.error('[Blackbar]', err);
    await flashBadge(tab.id, err.message === 'UNSUPPORTED_PAGE' ? '\u2014' : '!', '#f2c14e');
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse).catch((err) => sendResponse({ error: String(err?.message || err) }));
  return true; // async
});

async function handle(msg, sender) {
  switch (msg.type) {
    case 'BB_START': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('No active tab');
      await start(tab, msg.mode);
      return { ok: true };
    }
    case 'BB_CAPTURE_TILE': {
      const dataUrl = await captureThrottled(sender.tab.windowId);
      const job = jobs.get(sender.tab.id);
      if (!job) throw new Error('No capture in progress');
      job.tiles.push({ dataUrl, x: msg.x, y: msg.y });
      // Progress goes on the toolbar icon, where the camera can't see it.
      if (msg.total > 1) {
        await chrome.action.setBadgeText({ text: `${job.tiles.length}/${msg.total}`, tabId: sender.tab.id });
        await chrome.action.setBadgeBackgroundColor({ color: '#f2c14e', tabId: sender.tab.id });
      }
      return { ok: true, index: job.tiles.length };
    }
    case 'BB_FINISH': {
      return finish(sender.tab.id, msg);
    }
    case 'BB_CANCEL': {
      jobs.delete(sender.tab?.id);
      return { ok: true };
    }
    default:
      throw new Error(`Unknown message ${msg.type}`);
  }
}

/* ---------------------------------------------------------------- */

async function start(tab, mode) {
  if (!/^https?:|^file:/.test(tab.url || '')) {
    // chrome://, the New Tab page and the Web Store are off limits to EVERY
    // extension — Chrome enforces it, no permission unlocks it. Say so plainly
    // instead of failing quietly, and point at the way through.
    await notifyUnsupported(tab);
    throw new Error('UNSUPPORTED_PAGE');
  }
  jobs.set(tab.id, { tiles: [], mode, startedAt: Date.now() });

  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/capture.js'] });
  await chrome.tabs.sendMessage(tab.id, { type: 'BB_BEGIN', mode });
}

async function captureThrottled(windowId) {
  const wait = Math.max(0, CAPTURE_MIN_INTERVAL - (Date.now() - lastCaptureAt));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      lastCaptureAt = Date.now();
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      if (!/MAX_CAPTURE/i.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  throw new Error('Chrome refused repeated captures. Try again in a moment.');
}

async function finish(tabId, msg) {
  const job = jobs.get(tabId);
  if (!job) throw new Error('No capture in progress');
  jobs.delete(tabId);

  // Single-shot modes capture here so the overlay is already gone from the page.
  if (job.tiles.length === 0) {
    const tab = await chrome.tabs.get(tabId);
    job.tiles.push({ dataUrl: await captureThrottled(tab.windowId), x: 0, y: 0 });
  }

  await chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});

  const id = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await putCapture({
    id,
    createdAt: Date.now(),
    mode: job.mode,
    dpr: msg.dpr,
    width: msg.width,
    height: msg.height,
    crop: msg.crop || null,
    findings: msg.findings || [],
    unreadable: msg.unreadable || [],
    source: msg.source || '',
    tiles: job.tiles.map((t) => ({ x: t.x, y: t.y, blob: dataUrlToBlob(t.dataUrl) })),
  });

  await chrome.tabs.create({ url: chrome.runtime.getURL(`src/editor/editor.html?id=${id}`) });
  sweep().catch(() => {});
  return { ok: true };
}

/** Decode without fetch() — connect-src 'none' means even data: URLs are off the table. */
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(5, comma);
  const type = meta.split(';')[0] || 'image/png';
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function notifyUnsupported(tab) {
  await chrome.action.setBadgeText({ text: '—', tabId: tab.id });
  await chrome.action.setBadgeBackgroundColor({ color: '#8E8A7E', tabId: tab.id });
  setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }).catch(() => {}), 2500);
}
