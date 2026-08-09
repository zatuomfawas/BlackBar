import { scanText, luhn, ibanValid, entropy } from '../extension/src/lib/detectors.js';

/**
 * Credential fixtures are assembled at runtime instead of written as literals.
 *
 * This repository is a detector for credentials, so it is naturally full of
 * credential-shaped strings. GitHub's push protection blocks commits containing
 * them, and every fork inherits the alerts. Splitting the literal keeps the
 * scanner quiet while the detector still receives the whole string at runtime,
 * which is the only thing these tests care about.
 *
 * None of these are real. Several are the vendors' own documentation examples.
 */
const fake = (...parts) => parts.join('');

let pass = 0, fail = 0;
const ids = (t) => scanText(t).map((f) => f.ruleId);

function hit(text, ruleId) {
  const got = ids(text);
  if (got.includes(ruleId)) { pass++; }
  else { fail++; console.log(`  MISS  [${ruleId}] in ${JSON.stringify(text.slice(0, 70))} -> got ${got.join(',') || 'nothing'}`); }
}
function miss(text, label = '') {
  const got = ids(text);
  if (got.length === 0) { pass++; }
  else { fail++; console.log(`  FALSE POSITIVE ${label} ${JSON.stringify(text.slice(0, 70))} -> ${got.join(',')}`); }
}
function eq(actual, expected, label) {
  if (actual === expected) { pass++; }
  else { fail++; console.log(`  WRONG ${label}: got ${actual}, expected ${expected}`); }
}

console.log('\n— validators —');
eq(luhn('4242424242424242'), true, 'luhn valid visa');
eq(luhn('4242424242424241'), false, 'luhn invalid');
eq(ibanValid('GB82 WEST 1234 5698 7654 32'), true, 'iban valid');
eq(ibanValid('GB82 WEST 1234 5698 7654 33'), false, 'iban invalid');
eq(entropy('aaaaaaaa') < 1, true, 'low entropy');

console.log('\n— should detect —');
hit('contact me at jane.doe+tag@sub.example.co.uk please', 'email');
hit('card 4242 4242 4242 4242 exp 04/27', 'credit_card');
hit('5555-5555-5555-4444', 'credit_card');
hit('ssn 123-45-6789', 'ssn');
hit(fake('AKIA', 'IOSFODNN7EXAMPLE'), 'aws_key');
hit(fake('ghp', '_16C7e42F292c6912E7710c838347Ae178B4a'), 'github_token');
hit(fake('sk', '_live_', '4eC39HqLyjWDarjtT1zdp7dc'), 'stripe_key');
hit(fake('sk', '-proj-', 'abcdefghijklmnop1234567890QRSTUV'), 'openai_key');
hit(fake('AIza', 'SyC9x_QwErTyUiOpAsDfGhJkLzXcVbNm123'), 'google_key');
hit(fake('xoxb', '-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'), 'slack_token');
hit('token ' + fake('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NSJ9', '.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'jwt');
hit('Authorization: Bearer abc123def456ghi789jkl', 'bearer');
hit('-----BEGIN RSA PRIVATE KEY-----', 'private_key');
hit('https://api.site.com/v1?api_key=9f8a7b6c5d4e3f2a1b', 'url_secret');
hit('postgres://admin:hunter2@db.internal:5432/main', 'conn_string');
hit('GB82 WEST 1234 5698 7654 32', 'iban');
hit('0x71C7656EC7ab88b098defB751B7401B5f6d8976F', 'crypto_addr');
hit('call +1 (416) 555-0142 today', 'phone');
hit('server at 203.0.113.42 is down', 'ipv4');
hit('ship to 250 Yonge Street', 'street_address');
hit('M5B 2L7', 'postal_code');
hit('secret=Zx91kQmT7vLp02WdRb84YhNc35Fj', 'entropy_secret');

console.log('\n— should NOT fire (precision) —');
miss('The build finished in 1.2.3 seconds', 'version');
miss('Released on 2024-01-15 at 09:30', 'date');
miss('Total was 1234 5678 9012 3456 units', 'non-Luhn digits');
miss('localhost 127.0.0.1 and 192.168.1.10', 'private IPs');
miss('function getUserAccountBalance() { return 0 }', 'camelCase code');
miss('d41d8cd98f00b204e9800998ecf8427e', 'md5 hash');
miss('Lorem ipsum dolor sit amet consectetur adipiscing', 'prose');
miss('Order #100 shipped', 'order number');

console.log('\n— overlap resolution —');
{
  const f = scanText('4242 4242 4242 4242');
  eq(f.length, 1, 'card not double-reported as phone');
  eq(f[0]?.ruleId, 'credit_card', 'card wins overlap');
}
{
  const f = scanText('Email bob@corp.com or call 415-555-0199');
  eq(f.length, 2, 'two distinct findings');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
