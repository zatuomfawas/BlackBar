/**
 * Blackbar detection engine.
 *
 * Pure functions only. No DOM, no network, no globals beyond String/RegExp.
 * This module is shared by the DOM scanner (primary) and the OCR adapter
 * (fallback), and is unit-tested in Node via test/detectors.test.mjs.
 *
 * DESIGN RULE: precision over recall.
 * A false negative is a missed redaction the user can still catch by eye.
 * A false positive trains the user to ignore the ledger, which is worse —
 * once people stop reading detections, the product's core promise is dead.
 * So every detector that can be validated (Luhn, mod-97, entropy) is
 * validated, and anything we cannot do well (names, faces, free-text PII)
 * is deliberately NOT claimed. See STRATEGY.md § "What we refuse to detect".
 */

export const SEVERITY = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium' };

/* ------------------------------------------------------------------ */
/* Validators                                                          */
/* ------------------------------------------------------------------ */

export function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return digits.length > 0 && sum % 10 === 0;
}

export function ibanValid(raw) {
  const s = raw.replace(/[\s-]/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const part = code >= 65 && code <= 90 ? String(code - 55) : ch;
    if (!/^\d+$/.test(part)) return false;
    for (const d of part) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/** Shannon entropy in bits per character. */
export function entropy(str) {
  const freq = new Map();
  for (const ch of str) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / str.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function isPrivateIp(ip) {
  const p = ip.split('.').map(Number);
  return (
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254) ||
    p.every((n) => n === 0)
  );
}

/* Words that look like base64 blobs but are just prose or code identifiers. */
const ENTROPY_STOPLIST =
  /^(?:[A-Z][a-z]+){2,}$|^[a-z]+(?:[A-Z][a-z]+)+$|^[a-f0-9]{32}$|^[a-f0-9]{40}$|^[a-f0-9]{64}$/;

/* ------------------------------------------------------------------ */
/* Detector table                                                      */
/* ------------------------------------------------------------------ */

/**
 * Each rule: { id, label, severity, re, test?, transform? }
 *  - re      global regex; match[0] is the redaction target unless `span` given
 *  - test    optional post-filter (match) => boolean | severityOverride
 *  - span    optional (match) => [start, end] offsets relative to match.index
 */
export const RULES = [
  /* ---- credentials: always critical ---- */
  {
    id: 'private_key', label: 'Private key', severity: SEVERITY.CRITICAL,
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]{0,80}/g,
  },
  {
    id: 'aws_key', label: 'AWS key', severity: SEVERITY.CRITICAL,
    re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'github_token', label: 'GitHub token', severity: SEVERITY.CRITICAL,
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
  },
  {
    id: 'stripe_key', label: 'Stripe key', severity: SEVERITY.CRITICAL,
    re: /\b[srp]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    id: 'slack_token', label: 'Slack token', severity: SEVERITY.CRITICAL,
    re: /\bxox[baprse]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'openai_key', label: 'API key', severity: SEVERITY.CRITICAL,
    re: /\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'google_key', label: 'Google API key', severity: SEVERITY.CRITICAL,
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'sendgrid_key', label: 'SendGrid key', severity: SEVERITY.CRITICAL,
    re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    id: 'gitlab_token', label: 'GitLab token', severity: SEVERITY.CRITICAL,
    re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'npm_token', label: 'npm token', severity: SEVERITY.CRITICAL,
    re: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: 'jwt', label: 'JWT', severity: SEVERITY.CRITICAL,
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: 'bearer', label: 'Bearer token', severity: SEVERITY.CRITICAL,
    re: /\b(?:Bearer|Authorization:)\s+[A-Za-z0-9._~+/=-]{16,}/g,
  },
  {
    id: 'url_secret', label: 'Secret in URL', severity: SEVERITY.CRITICAL,
    re: /[?&](?:token|key|api[_-]?key|access[_-]?token|secret|password|pwd|sig|signature|auth|session)=[^&\s"'<>]{6,}/gi,
  },
  {
    id: 'conn_string', label: 'Connection string', severity: SEVERITY.CRITICAL,
    re: /\b[a-z][a-z0-9+.-]{2,15}:\/\/[^\s:@/]{1,64}:[^\s:@/]{1,64}@[^\s/]{2,}/gi,
  },

  /* ---- financial & government IDs ---- */
  {
    id: 'credit_card', label: 'Card number', severity: SEVERITY.CRITICAL,
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    test: (m) => {
      const d = m[0].replace(/\D/g, '');
      return d.length >= 13 && d.length <= 19 && /^[3-6]/.test(d) && luhn(d);
    },
  },
  {
    id: 'ssn', label: 'SSN', severity: SEVERITY.CRITICAL,
    re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  },
  {
    id: 'iban', label: 'IBAN', severity: SEVERITY.HIGH,
    re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[ ]?[A-Z0-9]{1,4}\b/g,
    test: (m) => ibanValid(m[0]),
  },
  {
    id: 'crypto_addr', label: 'Wallet address', severity: SEVERITY.HIGH,
    re: /\b(?:0x[a-fA-F0-9]{40}|bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g,
  },

  /* ---- contact data ---- */
  {
    id: 'email', label: 'Email', severity: SEVERITY.HIGH,
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}\b/g,
  },
  {
    id: 'phone', label: 'Phone', severity: SEVERITY.HIGH,
    re: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]\d{2,4}[ .-]\d{2,4}(?:[ .-]\d{2,4})?/g,
    test: (m) => {
      const d = m[0].replace(/\D/g, '');
      if (d.length < 9 || d.length > 15) return false;
      // Reject dates like 2024-01-15 and version strings like 1.2.3
      if (/^\d{4}[.-]\d{1,2}[.-]\d{1,2}$/.test(m[0].trim())) return false;
      return true;
    },
  },

  /* ---- network & location ---- */
  {
    id: 'ipv4', label: 'IP address', severity: SEVERITY.MEDIUM,
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    test: (m) => !isPrivateIp(m[0]),
  },
  {
    id: 'ipv6', label: 'IPv6 address', severity: SEVERITY.MEDIUM,
    re: /\b(?:[A-F0-9]{1,4}:){4,7}[A-F0-9]{1,4}\b/gi,
  },
  {
    id: 'street_address', label: 'Street address', severity: SEVERITY.MEDIUM,
    re: /\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][A-Za-z.'-]+\s){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Terrace|Ter|Place|Pl|Crescent|Cres|Highway|Hwy)\b\.?/g,
  },
  {
    id: 'postal_code', label: 'Postal code', severity: SEVERITY.MEDIUM,
    re: /\b(?:[A-Z]\d[A-Z][ -]?\d[A-Z]\d|\d{5}-\d{4})\b/g,
  },

  /* ---- last resort: unlabelled high-entropy strings ---- */
  {
    id: 'entropy_secret', label: 'Possible secret', severity: SEVERITY.MEDIUM,
    re: /\b[A-Za-z0-9+/=_-]{28,120}\b/g,
    test: (m) => {
      const s = m[0];
      if (ENTROPY_STOPLIST.test(s)) return false;
      if (!/[0-9]/.test(s) || !/[A-Za-z]/.test(s)) return false;
      if (!/[A-Z]/.test(s) && !/[+/=_-]/.test(s)) return false;
      return entropy(s) >= 3.7;
    },
  },
];

const RULE_ORDER = new Map(RULES.map((r, i) => [r.id, i]));
const SEV_RANK = { critical: 0, high: 1, medium: 2 };

/**
 * Scan a string. Returns non-overlapping findings sorted by position.
 * Overlaps are resolved by severity, then by rule order, then by length —
 * so a Luhn-valid card wins over a phone number that shares its digits.
 */
export function scanText(text) {
  if (!text || text.length > 200000) return [];
  const found = [];

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0].length === 0) { rule.re.lastIndex++; continue; }
      if (rule.test && !rule.test(m)) continue;
      found.push({
        ruleId: rule.id,
        label: rule.label,
        severity: rule.severity,
        start: m.index,
        end: m.index + m[0].length,
        value: m[0],
      });
    }
  }

  found.sort((a, b) => {
    if (SEV_RANK[a.severity] !== SEV_RANK[b.severity]) return SEV_RANK[a.severity] - SEV_RANK[b.severity];
    const ao = RULE_ORDER.get(a.ruleId), bo = RULE_ORDER.get(b.ruleId);
    if (ao !== bo) return ao - bo;
    return (b.end - b.start) - (a.end - a.start);
  });

  const kept = [];
  for (const f of found) {
    if (kept.some((k) => f.start < k.end && k.start < f.end)) continue;
    kept.push(f);
  }
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

/** Severities that get blacked out the moment a capture opens. */
export const DEFAULT_AUTO = new Set([SEVERITY.CRITICAL, SEVERITY.HIGH]);
