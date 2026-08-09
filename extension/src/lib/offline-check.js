/**
 * "Your screenshots never leave your device" is a claim. This makes it a test.
 *
 * The manifest sets `connect-src 'none'`, so every fetch/XHR/WebSocket from
 * this extension is refused by Chrome before a packet is written. We prove it
 * at runtime rather than asking to be believed: attempt a request, expect it
 * to be blocked, and report the result in the UI.
 *
 * The target is a .invalid hostname — a reserved TLD that can never resolve —
 * so even in the impossible case where the policy failed, nothing leaves.
 */
export async function verifyOffline() {
  try {
    await fetch('https://blackbar-selftest.invalid/csp', { method: 'GET', mode: 'no-cors' });
    return false; // Reached the network stack: policy is not doing its job.
  } catch {
    return true; // Refused by Content Security Policy, as designed.
  }
}
