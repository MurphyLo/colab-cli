import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAuthTimeoutMs } from '../.test-build/config.js';

const CLI = fileURLToPath(new URL('../.test-build/index.js', import.meta.url));

function login(t, timeout, ...args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-auth-timeout-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, COLAB_AUTH_TIMEOUT_SECONDS: timeout };
  delete env.COLAB_KAGGLE_URL;
  delete env.COLAB_PROFILE;
  return spawnSync(process.execPath, [CLI, 'auth', 'login', ...args], { env, encoding: 'utf-8' });
}

test('getAuthTimeoutMs defaults to 300 seconds', (t) => {
  const saved = process.env.COLAB_AUTH_TIMEOUT_SECONDS;
  delete process.env.COLAB_AUTH_TIMEOUT_SECONDS;
  t.after(() => {
    if (saved !== undefined) process.env.COLAB_AUTH_TIMEOUT_SECONDS = saved;
  });
  assert.equal(getAuthTimeoutMs(), 300_000);
});

test('getAuthTimeoutMs accepts whole seconds up to the setTimeout limit', () => {
  assert.equal(getAuthTimeoutMs('1'), 1_000);
  assert.equal(getAuthTimeoutMs('600'), 600_000);
  assert.equal(getAuthTimeoutMs('2147483'), 2_147_483_000);
});

test('getAuthTimeoutMs rejects anything else', () => {
  for (const raw of ['', ' ', '0', '-1', '1.5', '60s', 'abc', '1e3', '2147484']) {
    assert.throws(() => getAuthTimeoutMs(raw), /Invalid COLAB_AUTH_TIMEOUT_SECONDS/, JSON.stringify(raw));
  }
});

test('auth login --json reports the configured timeout', (t) => {
  // A 1-second timeout also ends the detached callback daemon right away.
  const result = login(t, '1', '--json');
  assert.equal(result.status, 0, result.stderr);
  const event = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(event.event, 'auth_required');
  assert.equal(event.timeoutSeconds, 1);
});

test('auth login fails on an invalid timeout before starting the flow', (t) => {
  const json = login(t, 'soon', '--json');
  assert.equal(json.status, 1);
  assert.match(JSON.parse(json.stdout.trim()).error, /Invalid COLAB_AUTH_TIMEOUT_SECONDS "soon"/);

  const foreground = login(t, 'soon');
  assert.equal(foreground.status, 1);
  assert.match(foreground.stderr, /Invalid COLAB_AUTH_TIMEOUT_SECONDS "soon"/);
});

test('an invalid timeout does not affect other commands', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-auth-timeout-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, COLAB_AUTH_TIMEOUT_SECONDS: 'soon' };
  delete env.COLAB_KAGGLE_URL;
  delete env.COLAB_PROFILE;
  const result = spawnSync(process.execPath, [CLI, 'auth', 'status', '--json'], { env, encoding: 'utf-8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).loggedIn, false);
});
