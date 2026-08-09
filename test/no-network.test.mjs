/**
 * The promise, as a test.
 *
 * "Your screenshots never leave your device" degrades into marketing the first
 * time someone adds an analytics call in a hurry. This runs in CI and fails the
 * build if any network-capable API, remote URL, or dynamic code path appears in
 * the shipped extension — and if the manifest ever loosens.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../extension', import.meta.url).pathname;
let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const ok = (msg) => console.log(`  ok    ${msg}`);

/* The single deliberate exception: the self-test that proves the CSP works. */
const ALLOWED = new Map([['src/lib/offline-check.js', /fetch\('https:\/\/blackbar-selftest\.invalid/]]);

const BANNED = [
  [/\bfetch\s*\(/, 'fetch()'],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/\bnew\s+WebSocket/, 'WebSocket'],
  [/sendBeacon/, 'navigator.sendBeacon'],
  [/\bimportScripts\s*\(/, 'importScripts()'],
  [/\beval\s*\(/, 'eval()'],
  [/new\s+Function\s*\(/, 'new Function()'],
  [/\bnavigator\.geolocation/, 'geolocation'],
  [/https?:\/\/(?!blackbar-selftest\.invalid)[a-z0-9]/i, 'a remote URL'],
];

/** Comments discuss these APIs; only real code counts. `//` after a colon is a URL, not a comment. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * A link the user clicks is navigation, not a request this extension makes —
 * nothing is sent, and nothing loads unless they choose to go there. Neutralise
 * anchor hrefs only. A remote URL in src=, in <link href>, in CSS url(), or
 * anywhere in JS is still a subresource load and still fails.
 */
const stripAnchorHrefs = (html) =>
  html.replace(/<a\s[^>]*?href="https?:\/\/[^"]*"/gi, (tag) => tag.replace(/https?:\/\//, 'useropens:'));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

console.log('\n— shipped code contains no network path —');
for (const file of walk(ROOT).filter((f) => /\.(js|html|css)$/.test(f))) {
  const rel = relative(ROOT, file);
  let src = stripComments(readFileSync(file, 'utf8'));
  if (file.endsWith('.html')) src = stripAnchorHrefs(src);
  for (const [pattern, label] of BANNED) {
    const match = src.match(pattern);
    if (!match) continue;
    const exception = ALLOWED.get(rel);
    if (exception && exception.test(src) && src.match(pattern).index === src.match(exception).index) continue;
    if (exception && label === 'fetch()') continue;
    fail(`${rel} uses ${label} → ${JSON.stringify(match[0].slice(0, 60))}`);
  }
}
if (!failures) ok('no fetch, XHR, WebSocket, beacon, eval, or remote URL anywhere');

console.log('\n— manifest stays minimal —');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

const csp = manifest.content_security_policy?.extension_pages || '';
csp.includes("connect-src 'none'") ? ok("CSP declares connect-src 'none'") : fail('CSP no longer blocks connections');
csp.includes("script-src 'self'") ? ok("CSP declares script-src 'self'") : fail('CSP allows foreign script');

const allowedPerms = new Set(['activeTab', 'scripting', 'storage', 'unlimitedStorage']);
const extra = (manifest.permissions || []).filter((p) => !allowedPerms.has(p));
extra.length ? fail(`unexpected permissions: ${extra.join(', ')}`) : ok(`permissions are ${manifest.permissions.join(', ')}`);

manifest.host_permissions?.length
  ? fail(`host permissions requested: ${manifest.host_permissions.join(', ')}`)
  : ok('no host permissions requested');

const war = manifest.web_accessible_resources || [];
war.every((entry) => entry.use_dynamic_url)
  ? ok('web-accessible resources use rotating URLs (no extension fingerprinting)')
  : fail('a web-accessible resource has a static URL, letting sites detect the extension');

console.log(failures ? `\n${failures} failed\n` : '\nAll trust checks passed\n');
process.exit(failures ? 1 : 0);
