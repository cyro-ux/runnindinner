'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { buildAssertion, isConfigured } = require('./gsc');

test('gsc: isConfigured is false zonder GSC_KEY_FILE', () => {
  delete process.env.GSC_KEY_FILE;
  assert.strictEqual(isConfigured(), false);
});

test('gsc: buildAssertion levert een geldige RS256-JWT met juiste claims', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { client_email: 'gsc-reader@test.iam.gserviceaccount.com',
                private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const jwt = buildAssertion(key, 1700000000);
  const [h, c, s] = jwt.split('.');
  const dec = (x) => JSON.parse(Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.deepStrictEqual(dec(h), { alg: 'RS256', typ: 'JWT' });
  const claims = dec(c);
  assert.strictEqual(claims.iss, key.client_email);
  assert.strictEqual(claims.exp - claims.iat, 3600);
  assert.match(claims.scope, /webmasters\.readonly/);
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey,
    Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  assert.ok(ok, 'handtekening verifieerbaar met de publieke sleutel');
});
