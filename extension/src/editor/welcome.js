import { verifyOffline } from '../lib/offline-check.js';

const LABELS = {
  'capture-area': 'Capture an area',
  'capture-visible': "Capture what's on screen",
  'capture-fullpage': 'Capture the whole page',
};

document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;

/**
 * Show the shortcuts that are actually bound, not the ones the manifest asked for.
 *
 * Chrome silently drops a suggested key if anything else already claimed it —
 * including an older copy of this same extension left loaded unpacked. The page
 * used to hardcode "Alt + Shift + A", so when that happened it confidently
 * documented a key that did nothing.
 */
chrome.commands.getAll().then((commands) => {
  const list = document.getElementById('keys');
  const note = document.getElementById('keysNote');
  list.replaceChildren();

  let unset = 0;
  for (const [name, label] of Object.entries(LABELS)) {
    const cmd = commands.find((c) => c.name === name);
    const shortcut = cmd?.shortcut || '';
    const li = document.createElement('li');
    if (!shortcut) { li.dataset.unset = 'true'; unset++; }
    li.innerHTML = `<span></span><kbd></kbd>`;
    li.firstChild.textContent = label;
    li.lastChild.textContent = shortcut || 'not assigned';
    list.append(li);
  }

  note.textContent = unset
    ? `${unset === 1 ? 'One shortcut is' : `${unset} shortcuts are`} unassigned — Chrome does that when another extension already claimed the key, including an older copy of Blackbar you may still have loaded. Assign your own, or remove the duplicate from chrome://extensions.`
    : 'Every capture mode is also in the toolbar menu, which always works.';
}).catch(() => {
  document.getElementById('keys').innerHTML = '<li class="pending">Couldn\u2019t read shortcut bindings.</li>';
});

document.getElementById('setKeys').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

verifyOffline().then((ok) => {
  const chip = document.getElementById('chip');
  chip.dataset.verified = String(ok);
  chip.textContent = ok ? 'offline · verified just now' : 'offline · unverified';
});
