#!/usr/bin/env node
/**
 * Mint a licence key.
 *
 *   node tools/sign-license.mjs --order LS-10432 --seats 1
 *
 * Run it from the checkout provider's webhook, or by hand while sales are
 * slow enough to count on your fingers. Store nothing about the buyer: the
 * payload carries an order reference, not a name or an email address.
 */
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1]]);
    return acc;
  }, []),
);

const key = createPrivateKey(readFileSync(new URL('./private-key.pem', import.meta.url)));

const payload = {
  v: 1,
  t: 'pro',
  o: args.order || `manual-${Date.now().toString(36)}`,
  s: Number(args.seats || 1),
  d: new Date().toISOString().slice(0, 10),
};

const payloadBytes = Buffer.from(JSON.stringify(payload));
const signature = sign('sha256', payloadBytes, { key, dsaEncoding: 'ieee-p1363' });

const b64u = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

console.log(`BB1.${b64u(payloadBytes)}.${b64u(signature)}`);
