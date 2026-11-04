import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProfile } from '../.test-build/config.js';

const BUILD = fileURLToPath(new URL('../.test-build/', import.meta.url));
const CLI = path.join(BUILD, 'index.js');

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-profile-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function envFor(home, profile) {
  const env = { ...process.env, HOME: home };
  delete env.COLAB_KAGGLE_URL;
  delete env.COLAB_PROFILE;
  if (profile !== undefined) env.COLAB_PROFILE = profile;
  return env;
}

function cli(home, profile, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], { env: envFor(home, profile), encoding: 'utf-8' });
}

/** Evaluate a module snippet in a fresh process so config re-reads the env. */
function evalModule(home, profile, body) {
  const script = `
    const config = await import(${JSON.stringify(path.join(BUILD, 'config.js'))});
    const storage = await import(${JSON.stringify(path.join(BUILD, 'auth/storage.js'))});
    ${body}
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: envFor(home, profile),
      encoding: 'utf-8',
    }),
  );
}

const session = (email) => ({
  id: 'session-id',
  refreshToken: 'refresh-token',
  account: { id: email, label: 'Test User' },
  scopes: ['email'],
});

test('profile names are lowercased and default means the root directory', () => {
  assert.equal(parseProfile(undefined), undefined);
  assert.equal(parseProfile('default'), undefined);
  assert.equal(parseProfile('DEFAULT'), undefined);
  assert.equal(parseProfile('Work'), 'work');
  assert.equal(parseProfile('First.Last+tag@Gmail.com'), 'first.last+tag@gmail.com');
});

test('unsafe or empty profile names are rejected', () => {
  for (const raw of ['', ' ', '.', '..', '../x', 'a/b', 'a\\b', '.hidden', '-x', 'a b', 'a\n']) {
    assert.throws(() => parseProfile(raw), /Invalid COLAB_PROFILE/, JSON.stringify(raw));
  }
});

test('only the Colab session and runtime records follow the profile', (t) => {
  const home = tempHome(t);
  const root = path.join(home, '.config', 'colab-cli');
  const read = 'console.log(JSON.stringify(config));';
  const def = evalModule(home, undefined, read);
  const work = evalModule(home, 'Work', read);

  assert.equal(def.AUTH_FILE, path.join(root, 'auth.json'));
  assert.equal(def.SERVERS_FILE, path.join(root, 'servers.json'));
  assert.equal(work.AUTH_FILE, path.join(root, 'profiles', 'work', 'auth.json'));
  assert.equal(work.SERVERS_FILE, path.join(root, 'profiles', 'work', 'servers.json'));

  assert.equal(work.CONFIG_DIR, root);
  for (const key of ['DRIVE_AUTH_FILE', 'DRIVE_MOUNT_AUTH_FILE', 'DRIVE_UPLOADS_DIR', 'SHELL_COUNTER_FILE']) {
    assert.equal(work[key], def[key], key);
  }
});

test('only Colab login carries the account selection options', (t) => {
  const home = tempHome(t);
  const read = 'console.log(JSON.stringify(config.COLAB_AUTH_URL_OPTIONS));';
  assert.deepEqual(evalModule(home, 'work', read), { prompt: 'select_account consent' });
  assert.deepEqual(evalModule(home, 'A@Gmail.com', read), {
    prompt: 'select_account consent',
    login_hint: 'a@gmail.com',
  });
});

test('an email profile only accepts its own account', (t) => {
  const home = tempHome(t);
  const store = (email) => `
    try {
      storage.storeSession(${JSON.stringify(session(email))});
      console.log(JSON.stringify({ stored: storage.getStoredSession()?.account.id ?? null }));
    } catch (err) {
      console.log(JSON.stringify({ error: err.message, stored: storage.getStoredSession()?.account.id ?? null }));
    }
  `;
  const rejected = evalModule(home, 'a@gmail.com', store('b@gmail.com'));
  assert.match(rejected.error, /Signed in as b@gmail\.com, but COLAB_PROFILE is a@gmail\.com/);
  assert.equal(rejected.stored, null);

  assert.deepEqual(evalModule(home, 'A@gmail.com', store('a@GMAIL.com')), { stored: 'a@GMAIL.com' });
  assert.deepEqual(evalModule(home, 'work', store('b@gmail.com')), { stored: 'b@gmail.com' });
});

test('profile credentials are private and do not touch the default session', (t) => {
  const home = tempHome(t);
  const root = path.join(home, '.config', 'colab-cli');
  evalModule(home, 'work', `storage.storeSession(${JSON.stringify(session('w@gmail.com'))}); console.log('{}');`);

  const file = path.join(root, 'profiles', 'work', 'auth.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(root, 'auth.json')), false);
});

test('auth list shows every profile and marks the active one', (t) => {
  const home = tempHome(t);
  const root = path.join(home, '.config', 'colab-cli');
  fs.mkdirSync(path.join(root, 'profiles', 'b@gmail.com'), { recursive: true });
  fs.mkdirSync(path.join(root, 'profiles', 'empty'));
  fs.mkdirSync(path.join(root, 'profiles', 'Not Selectable'));
  fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify(session('root@gmail.com')));
  fs.writeFileSync(path.join(root, 'profiles', 'b@gmail.com', 'auth.json'), JSON.stringify(session('b@gmail.com')));

  const result = cli(home, 'B@gmail.com', 'auth', 'list', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    command: 'auth.list',
    profiles: [
      { name: 'default', email: 'root@gmail.com', active: false },
      { name: 'b@gmail.com', email: 'b@gmail.com', active: true },
      { name: 'empty', email: null, active: false },
    ],
  });
});

test('an unknown profile reports not logged in instead of using the default account', (t) => {
  const home = tempHome(t);
  const root = path.join(home, '.config', 'colab-cli');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify(session('root@gmail.com')));

  const result = cli(home, 'typo', 'auth', 'status', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { command: 'auth.status', loggedIn: false, profile: 'typo' });

  const blocked = cli(home, 'typo', 'runtime', 'list');
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Not logged in \(profile: typo\)\. Run `COLAB_PROFILE=typo colab auth login` first\./);
});

test('an invalid profile exits cleanly before any command runs', (t) => {
  const home = tempHome(t);
  const text = cli(home, '../evil', 'auth', 'status');
  assert.equal(text.status, 1);
  assert.match(text.stderr, /^Error: Invalid COLAB_PROFILE "\.\.\/evil"/);

  const json = cli(home, '', 'auth', 'status', '--json');
  assert.equal(json.status, 1);
  assert.match(JSON.parse(json.stdout).error, /Invalid COLAB_PROFILE ""/);
  assert.equal(fs.existsSync(path.join(home, '.config')), false);
});
