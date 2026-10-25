import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.js reads these at import time; keep the test away from the real config dir.
process.env.COLAB_DRIVEFS_CLIENT_ID ??= 'test-client';
process.env.COLAB_DRIVEFS_CLIENT_SECRET ??= 'test-secret';
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-drive-mount-test-'));
const { DRIVEFS_SCOPES } = await import('../.test-build/config.js');
const { MountAuthManager } = await import('../.test-build/drive/mount-auth.js');
const { buildMountScript } = await import('../.test-build/drive/mount.js');

const CLIENT_CHANNEL = 'https://www.googleapis.com/auth/client_channel';

function withGrantedScope(scope) {
  const auth = new MountAuthManager();
  auth.oAuth2Client.setCredentials({ access_token: 'token', scope });
  return auth;
}

test('drive-mount requests the scope DriveFS needs for its push channel', () => {
  assert.ok(DRIVEFS_SCOPES.includes(CLIENT_CHANNEL));
});

test('missingScopes reports credentials authorized before client_channel was added', () => {
  const old = withGrantedScope('openid https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email');
  assert.deepEqual(old.missingScopes(), [CLIENT_CHANNEL]);
  const current = withGrantedScope(
    `openid https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email ${CLIENT_CHANNEL}`,
  );
  assert.deepEqual(current.missingScopes(), []);
  assert.deepEqual(withGrantedScope(undefined).missingScopes(), []);
});

test('mount script advertises DRIVEFS_SCOPES and is valid Python', () => {
  const script = buildMountScript('access', 'refresh', 'client', 'secret', 'user@example.com');
  assert.ok(script.includes(`_SCOPES = ${JSON.stringify(DRIVEFS_SCOPES.join(' '))}`));
  execFileSync('python3', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], { input: script });
});
