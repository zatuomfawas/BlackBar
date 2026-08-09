# Blackbar

Screenshot tool that blacks out secrets before you see the shot.
Everything runs on your device. [Chrome Web Store](https://chromewebstore.google.com/) · [Privacy policy](PRIVACY.md)

No build step. No dependencies. No minification. What is in this repository is
what is in the packaged extension.

---

## Came here to check the privacy claim?

Three files, about five minutes:

1. **[`extension/manifest.json`](extension/manifest.json)** — look for
   `"connect-src 'none'"` under `content_security_policy`. Chrome enforces this
   on the extension; it is not a promise, it is a rule the browser applies to
   us. Note also that `permissions` is only `activeTab`, `scripting`, `storage`,
   `unlimitedStorage` — there are **no host permissions**, which is why
   installing does not ask to read your data on all websites.

2. **[`extension/src/lib/offline-check.js`](extension/src/lib/offline-check.js)**
   — the extension attempts a network request every time the editor opens,
   expects to be blocked by its own policy, and reports the result in the
   status bar. That is the `offline · verified` chip.

3. **[`test/no-network.test.mjs`](test/no-network.test.mjs)** — a test that
   fails the build if `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`,
   `eval`, or any remote URL appears anywhere in the shipped code, or if the
   manifest ever loosens. It runs on every push.

```bash
git clone https://github.com/zatuomfawas/BlackBar
cd BlackBar && npm test        # no install step; there are no dependencies
```

Or just turn off your Wi-Fi and use the extension. It works.

---

## Run it

```bash
git clone <repo> && cd blackbar
```

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Open any normal website (not `chrome://`, not the Web Store — Chrome blocks
   every extension there) and press **Alt+Shift+S**

Tests:

```bash
node test/detectors.test.mjs   # 38 assertions, no dependencies
```

## How it finds things

Other redactors OCR the finished bitmap. In a browser that's the wrong tool:
OCR is slow, needs ~12 MB of WASM in the package, and misreads characters —
which is fatal when the string you're hiding is an API key.

Blackbar reads the DOM before capturing. `Range.getClientRects()` gives
character-exact pixel geometry for every match in about 20 ms.

Anything the DOM can't explain — `<img>`, `<canvas>`, `<video>`, cross-origin
frames — is reported as an **unreadable region** rather than assumed safe.

### Detection rules

Twenty-four rules across four groups. Everything that can be validated is:

- **Credentials** — AWS, GitHub, Stripe, Slack, Google, SendGrid, GitLab, npm
  keys; JWTs; bearer tokens; private key blocks; secrets in URL query strings;
  connection strings with inline passwords
- **Financial and government IDs** — card numbers (Luhn-checked), IBANs
  (mod-97-checked), US SSNs, crypto wallet addresses
- **Contact data** — emails, phone numbers, password fields
- **Location and network** — public IPv4/IPv6, street addresses, postal codes
- **Unlabelled secrets** — high-entropy strings (Shannon ≥ 3.7) that don't match
  a known prefix

Not detected, deliberately: names, faces, and free-text personal information.
A detector that's wrong half the time trains people to ignore the list, and the
list is the product. See `STRATEGY.md` § 2.

## Architecture

```
extension/
  manifest.json              MV3. activeTab only; connect-src 'none'
  src/
    background.js            capture orchestration, throttled captureVisibleTab
    content/capture.js       selection overlay, scroll-and-stitch, DOM scanner
    editor/editor.js         op model, safe-by-default ledger, flatten on export
    lib/detectors.js         pure detection rules (unit-tested in Node)
    lib/db.js                IndexedDB handoff, service worker → editor
    lib/license.js           offline ECDSA licence verification
    lib/offline-check.js     runtime proof that the CSP blocks the network
tools/                       keygen + licence signing (run locally, never hosted)
test/                        detector tests
```

Captures move from the service worker to the editor through IndexedDB in the
extension's own origin, and the record is deleted the moment the editor reads
it. Anything left behind by a crashed tab is swept after five minutes.

## Redaction, honestly

Black bars are the only real redaction here. Blur and pixelation are included
because people expect them, but pixelated text has been recovered by
brute-force re-rendering for years, and the safety readout refuses to count
either as safe.

Export re-rasterises from the original bitmap, so a black bar is destroyed
pixels rather than a layer someone can peel off, and canvas re-encoding drops
all metadata on the way out.

## Licensing (the paid tier)

```bash
node tools/keygen.mjs                          # once, ever — keep the .pem offline
node tools/sign-license.mjs --order LS-10432   # per sale
```

Paste the printed public key into `PUBLIC_KEY_SPKI_B64` in
`src/lib/license.js`. Keys are verified in the browser with WebCrypto; there is
no activation server and no network call.

## Not built yet

- OCR fallback for imported images (v1.1 — bundled Tesseract, Pro-gated to
  justify the package size)
- Custom detection rules UI (v1.1)
- QR and barcode detection (v1.1)
- Batch redaction (v1.2)

## Licence

GPL-3.0. Read it, fork it, audit it. "Blackbar" is a trademark.
