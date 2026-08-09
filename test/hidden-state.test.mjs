/**
 * Guard against hidden elements that aren't.
 *
 * `[hidden] { display: none }` comes from the browser's stylesheet, so any
 * author rule setting `display` on the same element wins and the element stays
 * on screen. That's how the paste prompt ended up permanently overlaying the
 * canvas, and how the "couldn't read" panel showed with nothing in it.
 *
 * This checks every page that uses the hidden attribute has a rule making the
 * attribute authoritative.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../extension/src', import.meta.url).pathname;
let failures = 0;
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const ok = (m) => console.log(`  ok    ${m}`);

const pages = [
  { html: join(ROOT, 'editor/editor.html'), css: join(ROOT, 'editor/editor.css'), name: 'editor' },
  { html: join(ROOT, 'popup/popup.html'), css: join(ROOT, 'popup/popup.css'), name: 'popup' },
];

console.log('\n— hidden elements stay hidden —');
for (const page of pages) {
  const html = readFileSync(page.html, 'utf8');
  const css = readFileSync(page.css, 'utf8');

  const hiddenEls = [...html.matchAll(/<[^>]*\bid="([A-Za-z0-9_]+)"[^>]*\bhidden\b[^>]*>/g)].map((m) => m[1]);
  if (!hiddenEls.length) { ok(`${page.name}: no hidden elements`); continue; }

  const guarded = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css);
  if (guarded) {
    ok(`${page.name}: ${hiddenEls.length} hidden element(s), attribute is authoritative`);
    continue;
  }

  // No global guard — check each one individually for a display rule that would win.
  for (const id of hiddenEls) {
    const classMatch = html.match(new RegExp(`class="([^"]*)"[^>]*id="${id}"|id="${id}"[^>]*class="([^"]*)"`));
    const classes = (classMatch?.[1] || classMatch?.[2] || '').split(/\s+/).filter(Boolean);
    for (const cls of classes) {
      const rule = css.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`));
      if (rule && /display\s*:/.test(rule[1])) {
        fail(`${page.name}: #${id} is hidden in HTML but .${cls} sets display — it will render anyway`);
      }
    }
  }
}

console.log(failures ? `\n${failures} failed\n` : '\nAll hidden-state checks passed\n');
process.exit(failures ? 1 : 0);
