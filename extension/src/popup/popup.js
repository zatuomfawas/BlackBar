import { verifyOffline } from '../lib/offline-check.js';

const note = document.getElementById('note');
const modes = document.querySelector('.modes');

/**
 * Chrome refuses to let ANY extension read chrome:// pages — the New Tab page,
 * Settings, the Web Store. No permission unlocks it. Rather than let someone
 * discover that by pressing the shortcut and watching nothing happen, check
 * before they click and offer the way through.
 */
const CAPTURABLE = /^(https?|file):/;

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // tab.url is undefined without activeTab; in that case don't pre-judge.
  if (tab?.url && !CAPTURABLE.test(tab.url)) blockCapture();
})();

function blockCapture() {
  for (const btn of modes.querySelectorAll('button[data-mode]')) btn.disabled = true;
  note.dataset.state = 'blocked';
  note.textContent = "Chrome won't let any extension capture this page. Take the shot with your system screenshot key, then paste it into the editor.";
  document.getElementById('paste').hidden = false;
}

modes.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn || btn.disabled) return;
  btn.setAttribute('aria-busy', 'true');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'BB_START', mode: btn.dataset.mode });
    if (res?.error) throw new Error(res.error);
    window.close();
  } catch (err) {
    btn.removeAttribute('aria-busy');
    if (/UNSUPPORTED_PAGE/.test(String(err))) { blockCapture(); return; }
    note.dataset.state = 'error';
    note.textContent = String(err.message || err);
  }
});

document.getElementById('paste').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/editor/editor.html') });
  window.close();
});

/**
 * Chrome silently drops a suggested shortcut if another extension already
 * claimed it, leaving a key that looks documented but does nothing. Read what
 * is actually bound and show that instead of what we asked for.
 */
chrome.commands.getAll().then((commands) => {
  const bound = Object.fromEntries(commands.map((c) => [c.name, c.shortcut]));
  const byMode = { area: 'capture-area', visible: 'capture-visible', fullpage: 'capture-fullpage' };
  let missing = 0;

  for (const btn of modes.querySelectorAll('button[data-mode]')) {
    const name = byMode[btn.dataset.mode];
    if (!name) continue;
    const kbd = btn.querySelector('kbd');
    const shortcut = bound[name];
    if (shortcut) {
      kbd.textContent = shortcut;
    } else {
      kbd.textContent = 'not set';
      kbd.dataset.unset = 'true';
      missing++;
    }
  }

  if (missing) {
    const fix = document.getElementById('fixKeys');
    fix.hidden = false;
    fix.textContent = missing === 1
      ? 'One shortcut was taken by another extension — set it →'
      : `${missing} shortcuts were taken by other extensions — set them →`;
  }
}).catch(() => {});

document.getElementById('fixKeys').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  window.close();
});

verifyOffline().then((ok) => {
  const chip = document.getElementById('chip');
  chip.textContent = ok ? 'offline · verified' : 'offline';
  chip.title = ok
    ? 'Checked just now: this extension is blocked from making network requests by its own security policy.'
    : 'This extension declares connect-src none, so it cannot make network requests.';
});
