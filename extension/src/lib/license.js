/**
 * Offline licensing.
 *
 * A privacy product cannot phone home to check a licence — that would be the
 * one network call in the whole extension, aimed at the one moment a user is
 * most sensitive. It would also cost money to run, which we don't have.
 *
 * So licences are signed offline. The checkout provider (a merchant of record
 * that handles VAT and charges 0/month) emails the buyer a key; the key is a
 * payload plus an ECDSA P-256 signature; the extension holds only the public
 * key and verifies with WebCrypto. Fixed infrastructure cost: $0. Network
 * calls: zero. Servers to breach: none.
 *
 * Yes, signed keys can be shared. That's a deliberate trade: at $24 one-time,
 * piracy costs less than a licence server would, and every cracked copy is
 * still a copy that can't leak anyone's screenshots.
 */

const PUBLIC_KEY_SPKI_B64 = 'REPLACE_WITH_OUTPUT_OF_tools/keygen.mjs';
const PREFIX = 'BB1';
const STORAGE_KEY = 'license';

let cached = null;

export async function getLicense() {
  if (cached) return cached;
  const { [STORAGE_KEY]: stored } = await chrome.storage.local.get(STORAGE_KEY);
  cached = stored?.valid ? stored : { valid: false, plan: 'free' };
  return cached;
}

export async function activate(keyString) {
  const result = await verify(keyString);
  if (!result.valid) return result;
  const record = { ...result, key: keyString.trim(), activatedAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEY]: record });
  cached = record;
  return record;
}

export async function deactivate() {
  await chrome.storage.local.remove(STORAGE_KEY);
  cached = { valid: false, plan: 'free' };
  return cached;
}

export async function verify(keyString) {
  try {
    const parts = String(keyString).trim().split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) {
      return { valid: false, plan: 'free', reason: "That doesn't look like a Blackbar key." };
    }
    if (PUBLIC_KEY_SPKI_B64.startsWith('REPLACE_')) {
      return { valid: false, plan: 'free', reason: 'This build has no signing key yet. Run tools/keygen.mjs.' };
    }
    const payloadBytes = b64uToBytes(parts[1]);
    const signature = b64uToBytes(parts[2]);
    const key = await crypto.subtle.importKey(
      'spki', b64ToBytes(PUBLIC_KEY_SPKI_B64),
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    );
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, key, signature, payloadBytes,
    );
    if (!ok) return { valid: false, plan: 'free', reason: 'This key failed its signature check.' };

    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    return { valid: true, plan: payload.t || 'pro', order: payload.o, issued: payload.d, seats: payload.s || 1 };
  } catch (err) {
    return { valid: false, plan: 'free', reason: 'That key could not be read.' };
  }
}

export const isPro = async () => (await getLicense()).plan === 'pro';

/* ---- encoding helpers ---- */

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64uToBytes(b64u) {
  return b64ToBytes(b64u.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64u.length / 4) * 4, '='));
}
