import test from 'node:test';
import assert from 'node:assert/strict';
import { checkServerUrl } from '../packages/service/src/cloud.js';

test('public HTTP requires an explicit matching backend and cannot expand to other endpoints', () => {
  const previous = process.env.PI_BOT_HTTP_SERVER_URL;
  try {
    delete process.env.PI_BOT_HTTP_SERVER_URL;
    assert.equal(checkServerUrl('https://backend.example/pibot/'), 'https://backend.example/pibot');
    assert.equal(checkServerUrl('http://localhost:8000'), 'http://localhost:8000');
    assert.equal(checkServerUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000');
    assert.equal(checkServerUrl('http://[::1]:8000/'), 'http://[::1]:8000');
    assert.throws(() => checkServerUrl('http://192.0.2.10:8000'), /HTTPS/);
    assert.throws(() => checkServerUrl('http://backend.example:8000'), /HTTPS/);

    process.env.PI_BOT_HTTP_SERVER_URL = 'http://BACKEND.example:8000/pibot/';
    assert.equal(checkServerUrl('http://backend.example:8000/pibot///'), 'http://backend.example:8000/pibot');
    for (const address of [
      'http://other.example:8000/pibot',
      'http://backend.example:8001/pibot',
      'http://backend.example:8000/other',
      'http://backend.example:8000/pibot?token=value',
      'http://backend.example:8000/pibot#fragment',
      'http://user:password@backend.example:8000/pibot',
      'ftp://backend.example:8000/pibot',
    ]) assert.throws(() => checkServerUrl(address));

    process.env.PI_BOT_HTTP_SERVER_URL = 'invalid';
    assert.throws(() => checkServerUrl('http://backend.example:8000'), /HTTPS/);
  } finally {
    if (previous === undefined) delete process.env.PI_BOT_HTTP_SERVER_URL;
    else process.env.PI_BOT_HTTP_SERVER_URL = previous;
  }
});
