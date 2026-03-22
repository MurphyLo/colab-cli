import { DaemonClient } from '../daemon/client.js';
import { MountAuthManager } from './mount-auth.js';
import { DRIVEFS_CLIENT_ID, DRIVEFS_CLIENT_SECRET } from '../config.js';
import type { KernelOutput } from '../jupyter/kernel-connection.js';

const MOUNT_TIMEOUT_S = 90;
const MOUNTPOINT = '/content/drive';

/**
 * Build the Python code that runs inside the Colab kernel to mount Drive.
 *
 * It starts a tiny HTTP server that impersonates a GCE metadata endpoint,
 * serving Drive access tokens to the DriveFS binary. The metadata server
 * handles automatic token refresh so long-running sessions don't break.
 */
function buildMountScript(
  accessToken: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  email: string,
): string {
  return `
import http.server, json, threading, os, subprocess, time, sys, urllib.request, urllib.parse

_ACCESS_TOKEN = ${JSON.stringify(accessToken)}
_REFRESH_TOKEN = ${JSON.stringify(refreshToken)}
_CLIENT_ID = ${JSON.stringify(clientId)}
_CLIENT_SECRET = ${JSON.stringify(clientSecret)}
_USER_EMAIL = ${JSON.stringify(email)}
_SCOPES = 'email https://www.googleapis.com/auth/drive'
_TOKEN_EXPIRY = time.time() + 3500
_TOKEN_LOCK = threading.Lock()

def _refresh_access_token():
    global _ACCESS_TOKEN, _TOKEN_EXPIRY
    data = urllib.parse.urlencode({
        'grant_type': 'refresh_token',
        'refresh_token': _REFRESH_TOKEN,
        'client_id': _CLIENT_ID,
        'client_secret': _CLIENT_SECRET,
    }).encode()
    req = urllib.request.Request('https://oauth2.googleapis.com/token', data=data)
    resp = urllib.request.urlopen(req, timeout=30)
    result = json.loads(resp.read().decode())
    _ACCESS_TOKEN = result['access_token']
    _TOKEN_EXPIRY = time.time() + result.get('expires_in', 3500) - 120

def _get_token():
    global _ACCESS_TOKEN, _TOKEN_EXPIRY
    with _TOKEN_LOCK:
        if time.time() > _TOKEN_EXPIRY:
            _refresh_access_token()
        return _ACCESS_TOKEN

class _MetadataHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if '/token' in self.path:
            tok = _get_token()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'access_token': tok,
                'expires_in': max(int(_TOKEN_EXPIRY - time.time()), 60),
                'scope': _SCOPES,
                'token_type': 'Bearer',
            }).encode())
        elif '/email' in self.path:
            self._text(_USER_EMAIL)
        elif 'guest-attributes' in self.path:
            self._text(_USER_EMAIL)
        elif '/scopes' in self.path:
            self._text(_SCOPES)
        elif 'service-accounts' in self.path:
            self._text('default/\\n')
        else:
            self._text('ok')

    def _text(self, body):
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.end_headers()
        self.wfile.write(body.encode() if isinstance(body, str) else body)

    def log_message(self, *_):
        pass

_srv = http.server.HTTPServer(('127.0.0.1', 0), _MetadataHandler)
_port = _srv.server_address[1]
threading.Thread(target=_srv.serve_forever, daemon=True).start()

subprocess.run(['pkill', '-9', '-x', 'drive'], capture_output=True)
time.sleep(0.3)

_mp = ${JSON.stringify(MOUNTPOINT)}
os.makedirs(_mp, exist_ok=True)
subprocess.run(['umount', '-f', _mp], capture_output=True)
subprocess.run(['umount', _mp], capture_output=True)

_dd = '/opt/google/drive'
_proc = subprocess.Popen(
    f'{_dd}/drive'
    ' --features='
    'crash_throttle_percentage:100,'
    'fuse_max_background:1000,'
    'max_read_qps:1000,'
    'max_write_qps:1000,'
    'max_operation_batch_size:15,'
    'max_parallel_push_task_instances:10,'
    'opendir_timeout_ms:120000,'
    'virtual_folders_omit_spaces:true'
    f' --metadata_server_auth_uri=http://127.0.0.1:{_port}/computeMetadata/v1'
    f' --preferences='
    f'trusted_root_certs_file_path:{_dd}/roots.pem,'
    'feature_flag_restart_seconds:129600,'
    f'mount_point_path:{_mp}',
    shell=True,
    env={
        'HOME': '/root',
        'FUSE_DEV_NAME': '/dev/fuse',
        'PATH': os.environ.get('PATH', ''),
    },
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
)

for _i in range(${MOUNT_TIMEOUT_S}):
    time.sleep(1)
    if os.path.isdir(os.path.join(_mp, 'My Drive')):
        print(f'Drive mounted at {_mp}')
        break
    if _proc.poll() is not None:
        _out = _proc.stdout.read().decode()[-800:] if _proc.stdout else ''
        raise RuntimeError(f'DriveFS exited with code {_proc.returncode}: {_out}')
else:
    _proc.terminate()
    raise RuntimeError('Drive mount timed out')
`;
}

export async function mountDrive(
  client: DaemonClient,
  mountAuth: MountAuthManager,
): Promise<void> {
  const accessToken = await mountAuth.getAccessToken();
  const refreshToken = mountAuth.getRefreshToken();
  const email = mountAuth.getEmail() ?? 'user@gmail.com';

  const script = buildMountScript(
    accessToken,
    refreshToken,
    DRIVEFS_CLIENT_ID!,
    DRIVEFS_CLIENT_SECRET!,
    email,
  );

  const outputs = client.exec(script);
  const collected: KernelOutput[] = [];
  for await (const output of outputs) {
    collected.push(output);
  }

  // Check for errors in output
  const errorOutput = collected.find(
    (o) => o.type === 'error' || (o.type === 'stream' && o.name === 'stderr'),
  );
  if (errorOutput && errorOutput.type === 'error') {
    throw new Error(`Drive mount failed: ${errorOutput.ename}: ${errorOutput.evalue}`);
  }
}
