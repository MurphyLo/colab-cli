import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRuntimeNote } from '../.test-build/commands/runtime.js';

const BUILD = fileURLToPath(new URL('../.test-build/', import.meta.url));
const SERVER_ID = '123e4567-e89b-42d3-a456-426614174000';

function envFor(home) {
  const env = { ...process.env, HOME: home, FORCE_COLOR: '0' };
  delete env.COLAB_KAGGLE_URL;
  delete env.COLAB_PROFILE;
  return env;
}

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-note-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

/** Run a module snippet in a fresh process so config resolves the temp HOME. */
function run(home, body) {
  const script = `
    const storage = await import(${JSON.stringify(path.join(BUILD, 'runtime/storage.js'))});
    const commands = await import(${JSON.stringify(path.join(BUILD, 'commands/runtime.js'))});
    const output = await import(${JSON.stringify(path.join(BUILD, 'output/json-output.js'))});
    const server = (extra) => ({
      id: ${JSON.stringify(SERVER_ID)},
      label: 'Colab GPU T4',
      variant: 'GPU',
      accelerator: 'T4',
      endpoint: 'ep-1',
      proxyUrl: 'https://proxy.example',
      token: 'token',
      tokenExpiry: new Date(0),
      dateAssigned: new Date(0),
      kernelName: 'python3',
      ...extra,
    });
    const assignment = (endpoint) => ({ endpoint, accelerator: 'T4', variant: 'GPU', machineShape: 0 });
    const listManager = (endpoints) => ({
      list: async () => endpoints.map(assignment),
      getCreatedAt: async () => undefined,
      getServerByEndpoint: (endpoint) => storage.listStoredServers().find((s) => s.endpoint === endpoint),
    });
    ${body}
  `;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: envFor(home),
    encoding: 'utf-8',
  });
}

test('normalizeRuntimeNote collapses whitespace and strips control characters', () => {
  assert.equal(normalizeRuntimeNote('  repo foo\n\ttraining  '), 'repo foo training');
  assert.equal(normalizeRuntimeNote('a\u001b[31mb\u0000c'), 'a[31mbc');
  assert.equal(normalizeRuntimeNote('训练 模型'), '训练 模型');
});

test('normalizeRuntimeNote rejects empty and overlong notes', () => {
  assert.throws(() => normalizeRuntimeNote(' \n '), /must not be empty/);
  assert.throws(() => normalizeRuntimeNote('\u0007'), /must not be empty/);
  assert.equal(normalizeRuntimeNote('字'.repeat(200)).length, 200);
  assert.throws(() => normalizeRuntimeNote('字'.repeat(201)), /at most 200/);
});

test('an invalid note is rejected before a runtime is assigned', (t) => {
  const home = tempHome(t);
  const out = run(home, `
    let created = false;
    const manager = { create: async () => { created = true; } };
    const error = await commands
      .createRuntimeCommand(manager, { accelerator: 'T4', note: '   ' })
      .then(() => null, (err) => err.message);
    console.log(JSON.stringify({ created, error }));
  `);
  assert.deepEqual(JSON.parse(out), { created: false, error: 'Note must not be empty.' });
});

test('create passes the normalized note on and reports it', (t) => {
  const home = tempHome(t);
  const out = run(home, `
    output.setJsonMode(true);
    const seen = [];
    const manager = {
      create: async (options) => { seen.push(options.note); return server({ note: options.note }); },
    };
    await commands.createRuntimeCommand(manager, { accelerator: 'T4', note: ' repo\\nfoo ' });
    await commands.createRuntimeCommand(manager, { accelerator: 'T4' });
    console.log(JSON.stringify(seen.map((note) => note ?? null)));
  `).trim().split('\n');
  assert.equal(JSON.parse(out[0]).note, 'repo foo');
  assert.equal('note' in JSON.parse(out[1]), false);
  assert.deepEqual(JSON.parse(out[2]), ['repo foo', null]);
});

test('the note survives a token refresh rewriting the state file', (t) => {
  const home = tempHome(t);
  const out = run(home, `
    storage.storeServer(server({ note: 'repo foo' }));
    storage.updateServerToken(${JSON.stringify(SERVER_ID)}, 'new', 'https://new.example', new Date(1));
    const stored = storage.getStoredServer(${JSON.stringify(SERVER_ID)});
    console.log(JSON.stringify({ note: stored.note, token: stored.token }));
  `);
  assert.deepEqual(JSON.parse(out), { note: 'repo foo', token: 'new' });
});

test('runtime note sets and clears the note on the resolved runtime only', (t) => {
  const home = tempHome(t);
  const out = run(home, `
    output.setJsonMode(true);
    const other = '223e4567-e89b-42d3-a456-426614174000';
    storage.storeServer(server({ note: 'before' }));
    storage.storeServer(server({ id: other, endpoint: 'ep-2', note: 'untouched' }));
    const targets = [];
    const manager = {
      resolveTarget: async (endpoint) => {
        targets.push(endpoint ?? null);
        return storage.getStoredServer(${JSON.stringify(SERVER_ID)});
      },
    };
    const note = (id) => storage.getStoredServer(id).note ?? null;
    const seen = [];
    await commands.noteRuntimeCommand(manager, ' repo\\nbar ', 'ep-1');
    seen.push(note(${JSON.stringify(SERVER_ID)}));
    await commands.noteRuntimeCommand(manager, '');
    seen.push(note(${JSON.stringify(SERVER_ID)}));
    const error = await commands.noteRuntimeCommand(manager, '   ', 'ep-1').then(() => null, (err) => err.message);
    console.log(JSON.stringify({ seen, other: note(other), targets, error }));
  `).trim().split('\n');
  assert.deepEqual(JSON.parse(out[0]), { command: 'runtime.note', endpoint: 'ep-1', note: 'repo bar' });
  assert.deepEqual(JSON.parse(out[1]), { command: 'runtime.note', endpoint: 'ep-1' });
  assert.deepEqual(JSON.parse(out[2]), {
    seen: ['repo bar', null],
    other: 'untouched',
    targets: ['ep-1', null],
    error: 'Note must not be empty.',
  });
});

test('runtime note fails when the local record is gone', (t) => {
  const home = tempHome(t);
  const out = run(home, `
    const manager = { resolveTarget: async () => server() };
    const error = await commands.noteRuntimeCommand(manager, 'x').then(() => null, (err) => err.message);
    console.log(JSON.stringify({ error }));
  `);
  assert.match(JSON.parse(out).error, /No local record/);
});

test('runtime list shows the note in JSON and text, and only where one exists', (t) => {
  const home = tempHome(t);
  const seed = `storage.storeServer(server({ note: 'repo foo training' }));`;

  const json = JSON.parse(run(home, `
    ${seed}
    output.setJsonMode(true);
    await commands.listRuntimesCommand(listManager(['ep-1', 'ep-unknown']));
  `));
  assert.equal(json.runtimes[0].note, 'repo foo training');
  assert.equal('note' in json.runtimes[1], false);

  const lines = run(home, `
    ${seed}
    await commands.listRuntimesCommand(listManager(['ep-1', 'ep-unknown']));
  `).split('\n');
  assert.match(lines.find((l) => l.includes('ep-1')), /note: repo foo training$/);
  assert.doesNotMatch(lines.find((l) => l.includes('ep-unknown')), /note:/);
});

test('--note is accepted by `runtime create` and described in its help', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-note-'));
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(BUILD, 'index.js'), 'runtime', 'create', '--help'],
      { env: envFor(home), encoding: 'utf-8' },
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /-n, --note <text>/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
