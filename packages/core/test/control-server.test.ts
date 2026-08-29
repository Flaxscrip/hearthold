/**
 * Origin policy for the control server — the CORS/CSRF boundary. Two modes:
 *  - strict (default): every local control plane. Only the configured allowlist + loopback + absent-Origin.
 *  - publicPortal: the public BYO-wallet Mage. ADDITIONALLY admits browser-EXTENSION origins (the wallet
 *    add-on's per-install id), but NOT arbitrary named web origins — the open web must gain no CORS read
 *    access. `null` (opaque) is refused in both modes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedOrigin } from '../src/control-server.ts';

const ALLOW = ['https://wallet.archon.technology'];

test('strict mode: only the allowlist + loopback + absent Origin', () => {
  assert.equal(isAllowedOrigin(undefined, ALLOW), true, 'no Origin (curl / same-origin) allowed');
  assert.equal(isAllowedOrigin('https://wallet.archon.technology', ALLOW), true, 'allowlisted origin');
  assert.equal(isAllowedOrigin('http://localhost:5173', ALLOW), true, 'loopback any port');
  assert.equal(isAllowedOrigin('https://evil.example.com', ALLOW), false, 'unlisted web origin refused');
  assert.equal(isAllowedOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop', ALLOW), false, 'extension NOT admitted in strict mode');
  assert.equal(isAllowedOrigin('null', ALLOW), false, 'opaque null refused');
});

test('publicPortal mode: adds browser-extension schemes, NOT the open web', () => {
  // The whole point: the wallet add-on's per-install extension origin is admitted…
  assert.equal(isAllowedOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop', ALLOW, true), true, 'chrome extension admitted');
  assert.equal(isAllowedOrigin('moz-extension://11111111-2222-3333-4444-555555555555', ALLOW, true), true, 'firefox extension admitted');
  // …while an arbitrary named web origin is STILL refused (falls through to the allowlist). This is the
  // regression guard: publicPortal must not become "allow any origin".
  assert.equal(isAllowedOrigin('https://evil.example.com', ALLOW, true), false, 'drive-by web page still refused in publicPortal mode');
  assert.equal(isAllowedOrigin('http://attacker.test', ALLOW, true), false, 'http attacker origin still refused');
  // The legitimate allowlist + loopback + absent still work.
  assert.equal(isAllowedOrigin('https://wallet.archon.technology', ALLOW, true), true, 'allowlisted wallet origin');
  assert.equal(isAllowedOrigin(undefined, ALLOW, true), true, 'absent Origin allowed');
  // Opaque null is refused even in publicPortal mode — an attacker sandboxed iframe must not post a response.
  assert.equal(isAllowedOrigin('null', ALLOW, true), false, 'opaque null still refused in publicPortal mode');
  // A named origin that merely CONTAINS an extension scheme substring must not slip through (prefix, not includes).
  assert.equal(isAllowedOrigin('https://chrome-extension.evil.com', ALLOW, true), false, 'lookalike host refused');
});
