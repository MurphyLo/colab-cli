import { contentsRequest, encodeContentsPath } from './contents-client.js';

/** Versioned, private to this client session; existing kernels are never patched globally. */
export const JOURNAL_ROOT = 'tmp/colab-cli-journal-v1';
export const JOURNAL_BOOTSTRAP = String.raw`
def _colab_cli_install_journal(client_session):
    import os, json, threading, base64, signal
    from jupyter_client.session import extract_header
    from jupyter_client.jsonutil import json_default
    k = get_ipython().kernel
    s = k.session
    st = getattr(s, '_colab_cli_journal_v1', None)
    if st is not None and st.get('version') != 3:
        s.send, s.recv = st['send'], st['recv']
        for e in st['executions'].values():
            if e.get('fd') is not None: os.close(e['fd'])
        st = None
    if st is None:
        st = dict(version=3, send=s.send, recv=s.recv, sessions=set(), executions={}, input_requests={}, skip=set(), lock=threading.RLock())
        def channel(stream):
            if stream is getattr(k, 'stdin_socket', None): return 'stdin'
            if stream is getattr(k, 'control_stream', None): return 'control'
            if stream is getattr(k, 'shell_stream', None) or stream in (getattr(k, 'shell_streams', None) or []): return 'shell'
            return 'iopub'
        def send(stream, msg_or_type, content=None, parent=None, ident=None, buffers=None, track=False, header=None, metadata=None):
            ph = msg_or_type.get('parent_header', {}) if isinstance(msg_or_type, dict) else extract_header(parent or {})
            eid = ph.get('msg_id') if ph.get('msg_type') == 'execute_request' else None
            session = ph.get('session')
            if session in st['sessions'] and not ph.get('msg_id'):
                current = extract_header(k.get_parent('shell'))
                if current.get('session') == session and current.get('msg_type') == 'execute_request': eid = current.get('msg_id')
            if session not in st['sessions'] or not eid or eid in st['skip']:
                return st['send'](stream, msg_or_type, content, parent, ident, buffers, track, header, metadata)
            previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})
            try:
                with st['lock']:
                    e = st['executions'].setdefault(eid, dict(seq=0, failed=False, size=0, fd=None))
                    m = dict(msg_or_type) if isinstance(msg_or_type, dict) else s.msg(msg_or_type, content=content, parent=parent, header=header, metadata=metadata)
                    m['metadata'] = dict(m.get('metadata', {}))
                    if m['header']['msg_type'] == 'input_request':
                        st['input_requests'][eid] = m['header']['msg_id']
                        m['metadata']['colab_cli_input_guard'] = True
                    seq = e['seq'] + 1
                    tag = dict(exec=eid, seq=seq, ok=not e['failed'])
                    m['metadata']['colab_cli_journal'] = tag
                    directory = '/tmp/colab-cli-journal-v1/' + session + '/' + eid
                    try:
                        if e['failed']: raise OSError('journal previously failed')
                        os.makedirs(directory, mode=0o700, exist_ok=True)
                        if e['fd'] is None or e['size'] >= 1048576:
                            if e['fd'] is not None: os.close(e['fd'])
                            e['fd'] = os.open(directory + '/%012d.jsonl' % seq, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                            e['size'] = 0
                        record = dict(seq=seq, channel=channel(stream), header=m['header'], parent_header=m['parent_header'], metadata=m['metadata'], content=m['content'], buffers=[base64.b64encode(bytes(b)).decode('ascii') for b in (buffers or m.get('buffers') or [])])
                        data = (json.dumps(record, default=json_default, ensure_ascii=True, allow_nan=False) + '\n').encode('utf8')
                        offset = 0
                        while offset < len(data): offset += os.write(e['fd'], data[offset:])
                        e['seq'] = seq
                        e['size'] += len(data)
                    except Exception as error:
                        e['failed'] = True
                        tag['ok'] = False
                        try:
                            with open(directory + '/FAILED', 'w') as f: f.write(type(error).__name__)
                        except Exception: pass
                    result = st['send'](stream, m, None, None, ident, buffers, track)
                    if m['header']['msg_type'] == 'status' and m['content'].get('execution_state') == 'idle' and e['fd'] is not None:
                        os.close(e['fd']); e['fd'] = None
                    return result
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        def recv(socket, *args, **kwargs):
            while True:
                result = st['recv'](socket, *args, **kwargs)
                if socket is not getattr(k, 'stdin_socket', None) or not result or not result[1]: return result
                reply = result[1]
                if reply.get('header', {}).get('msg_type') != 'input_reply': return result
                current = extract_header(k.get_parent('shell'))
                eid = current.get('msg_id')
                request_id = reply.get('metadata', {}).get('colab_cli_input_request')
                if request_id and request_id != st['input_requests'].get(eid):
                    # Late retries must never answer a subsequent prompt.
                    continue
                if request_id: st['input_requests'].pop(eid, None)
                send(k.iopub_socket, 'colab_cli_input_received', content={'reply_msg_id': reply['header']['msg_id'], 'request_id': request_id}, parent=k.get_parent('shell'))
                return result
        st['hook_recv'], st['hook_send'] = recv, send
        s._colab_cli_journal_v1 = st
    s.recv, s.send = st['hook_recv'], st['hook_send']
    st['sessions'].add(client_session)
    current = extract_header(k.get_parent('shell'))
    if current.get('msg_id'): st['skip'].add(current['msg_id'])
`;

export interface JournalMessage {
  seq: number;
  header: Record<string, any>;
  parent_header: Record<string, any>;
  metadata: Record<string, any>;
  content: Record<string, any>;
  channel?: string;
  buffers?: string[];
}

/** Ignore only an incomplete final line; malformed complete records are corruption. */
export function parseJournal(text: string): JournalMessage[] {
  const lines = text.split('\n');
  lines.pop();
  return lines.filter(Boolean).map(line => {
    const row = JSON.parse(line);
    if (!Number.isSafeInteger(row.seq) || row.seq < 1 || !row.header || !row.content) {
      throw new Error('Invalid execution journal record');
    }
    return row;
  });
}

export async function readJournal(url: string, token: string, session: string, execution: string, after: number, cache?: Map<string, string>): Promise<JournalMessage[]> {
  const directory = `${JOURNAL_ROOT}/${session}/${execution}`;
  const listing: any = await contentsRequest(url, token, encodeContentsPath(directory), { timeoutMs: 10_000 });
  if (!Array.isArray(listing?.content)) throw new Error('Invalid execution journal directory');
  if (listing.content.some((f: any) => f.name === 'FAILED')) throw new JournalIntegrityError('Remote execution journal failed; output completeness cannot be verified');
  const files = listing.content.filter((f: any) => /^\d{12}\.jsonl$/.test(f.name)).sort((a: any, b: any) => a.name.localeCompare(b.name));
  const rows: JournalMessage[] = [];
  for (let i = 0; i < files.length; i++) {
    if (i + 1 < files.length && Number(files[i + 1].name.slice(0, 12)) <= after) continue;
    const fingerprint = typeof files[i].size === 'number' && files[i].last_modified
      ? `${files[i].size}:${files[i].last_modified}` : undefined;
    if (fingerprint && cache?.get(files[i].name) === fingerprint) continue;
    const file: any = await contentsRequest(url, token, `${encodeContentsPath(directory + '/' + files[i].name)}?format=text&type=file`, { timeoutMs: 10_000 });
    try { rows.push(...parseJournal(file.content).filter(row => row.seq > after)); }
    catch { throw new JournalIntegrityError('Remote execution journal is corrupt; output completeness cannot be verified'); }
    if (fingerprint) cache?.set(files[i].name, fingerprint);
  }
  return rows;
}

export class JournalIntegrityError extends Error {}

export async function removeJournal(url: string, token: string, session: string, execution: string): Promise<void> {
  const directory = `${JOURNAL_ROOT}/${session}/${execution}`;
  const listing: any = await contentsRequest(url, token, encodeContentsPath(directory), { timeoutMs: 10_000 });
  if (!Array.isArray(listing?.content)) throw new Error('Invalid execution journal directory');
  for (const file of listing.content) {
    if (!/^\d{12}\.jsonl$/.test(file.name)) throw new Error('Refusing to clean an incomplete or unrecognized journal');
    await contentsRequest(url, token, encodeContentsPath(directory + '/' + file.name), { method: 'DELETE', timeoutMs: 10_000 });
  }
  await contentsRequest(url, token, encodeContentsPath(directory), { method: 'DELETE', timeoutMs: 10_000 });
}
