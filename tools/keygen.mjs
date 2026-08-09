#!/usr/bin/env node
/**
 * Generate the signing keypair. Run once, ever.
 *
 *   node tools/keygen.mjs
 *
 * Writes tools/private-key.pem (NEVER commit this — add it to .gitignore)
 * and prints the public key to paste into src/lib/license.js.
 */
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';

const OUT = new URL('./private-key.pem', import.meta.url);

if (existsSync(OUT)) {
  console.error('private-key.pem already exists. Refusing to overwrite — every key you have sold was signed with it.');
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

writeFileSync(OUT, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

console.log('\nWrote tools/private-key.pem (keep it offline and backed up).\n');
console.log('Paste this into extension/src/lib/license.js as PUBLIC_KEY_SPKI_B64:\n');
console.log(`  '${spki}'\n`);
