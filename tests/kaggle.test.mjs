import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKaggleUrl, findBaseInText } from '../.test-build/kaggle/url.js';
import { rejectUnsupported, parseForwardSpec } from '../.test-build/kaggle/cli.js';

const HOST = 'https://kkb-production.jupyter-proxy.kaggle.net';
const TOKEN = 'eyJhbGciOiJkaXIi..abc.def-ghi_jkl.mno';
const BASE = `${HOST}/k/123456789/${TOKEN}/proxy`;

test('VS Code form yields the base and session id', () => {
  for (const raw of [BASE, `${BASE}/`, `${BASE}/api/status`, `  ${BASE}  `]) {
    assert.deepEqual(parseKaggleUrl(raw), { form: 'path', target: { base: BASE, sessionId: '123456789' } });
  }
});

test('Colab form yields origin and token', () => {
  assert.deepEqual(parseKaggleUrl(`${HOST}?token=${TOKEN}`), { form: 'query', origin: HOST, token: TOKEN });
  assert.deepEqual(parseKaggleUrl(`${HOST}/?token=${TOKEN}`), { form: 'query', origin: HOST, token: TOKEN });
});

test('Open-in-Colab link is unwrapped through connectLocal', () => {
  const inner = `${HOST}?token=${TOKEN}`;
  const link = `https://colab.research.google.com/notebook#fileId=x&connectLocal=${encodeURIComponent(inner)}`;
  // connectLocal sits after '#', so it must also work when the fragment is turned into a query.
  const queryLink = `https://colab.research.google.com/notebook?fileId=x&connectLocal=${encodeURIComponent(inner)}`;
  assert.deepEqual(parseKaggleUrl(queryLink), { form: 'query', origin: HOST, token: TOKEN });
  assert.deepEqual(parseKaggleUrl(link), { form: 'query', origin: HOST, token: TOKEN });
});

test('invalid URLs are rejected with guidance', () => {
  assert.throws(() => parseKaggleUrl(''), /not a valid URL/);
  assert.throws(() => parseKaggleUrl(`http://example.com/k/1/t/proxy`), /https/);
  assert.throws(() => parseKaggleUrl(`${HOST}/somewhere`), /VSCode Compatible URL/);
});

test('base is recovered from base_url-prefixed paths in a Jupyter response', () => {
  const body = JSON.stringify({ resources: { 'logo-32x32': `/k/123456789/${TOKEN}/proxy/kernelspecs/python3/logo-32x32.png` } });
  assert.deepEqual(findBaseInText(HOST, body), { base: BASE, sessionId: '123456789' });
  assert.equal(findBaseInText(HOST, '{"kernelspecs":{}}'), undefined);
});

test('supported commands pass the Kaggle-mode gate', () => {
  for (const args of [
    [], ['--help'], ['help'], ['--json', 'runtime', 'list'],
    ['exec', 'print(1)'], ['exec', '-f', 'x.py'], ['--verbose', 'exec', '-o', 'out', 'print(1)'],
    ['fs', 'upload', 'a.bin', '-r', 'content/a.bin'], ['fs', 'download', 'content/a.bin'],
    ['port-forward', 'create', '8080'], ['pf', 'create', '1:2'],
    ['runtime', 'restart'], ['runtime', 'resources'], ['runtime'], ['fs', '--help'],
  ]) {
    assert.equal(rejectUnsupported(args), undefined, args.join(' '));
  }
});

test('everything else is rejected', () => {
  for (const [args, name] of [
    [['shell'], '`shell`'], [['auth', 'login'], '`auth`'], [['drive', 'list'], '`drive`'], [['usage'], '`usage`'],
    [['drive-mount'], '`drive-mount`'], [['runtime', 'create', '-a', 'T4'], '`runtime create`'],
    [['runtime', 'versions'], '`runtime versions`'], [['runtime', 'destroy'], '`runtime destroy`'], [['exec', 'attach', '1'], '`exec attach`'],
    [['exec', 'list'], '`exec list`'], [['exec', '-b', 'x'], '`exec --background`'],
    [['pf', 'list'], '`pf list`'], [['port-forward', 'close', '--all'], '`port-forward close`'],
    [['some-future-command'], '`some-future-command`'],
  ]) {
    const reason = rejectUnsupported(args);
    assert.ok(reason?.includes(name), `${args.join(' ')} -> ${reason}`);
    assert.match(reason, /Unset COLAB_KAGGLE_URL/);
  }
  assert.match(rejectUnsupported(['exec', '-e', 'ep', 'x']), /endpoint/);
  assert.match(rejectUnsupported(['runtime', 'list', '--endpoint=ep']), /endpoint/);
});

test('port-forward spec parsing', () => {
  assert.deepEqual(parseForwardSpec('8080'), { localHost: '127.0.0.1', localPort: 8080, remotePort: 8080 });
  assert.deepEqual(parseForwardSpec('9000:8080'), { localHost: '127.0.0.1', localPort: 9000, remotePort: 8080 });
  assert.deepEqual(parseForwardSpec('0.0.0.0:9000:8080'), { localHost: '0.0.0.0', localPort: 9000, remotePort: 8080 });
  assert.throws(() => parseForwardSpec('0'), /Invalid port/);
  assert.throws(() => parseForwardSpec(':1:2'), /Invalid spec/);
});
