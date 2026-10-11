#!/usr/bin/env python3
"""Приватний SSH-доступ до Mana Tape з Linux або macOS."""
import argparse
import http.client
import json
import os
import shlex
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import socket
import subprocess
import sys
import time
import threading
import webbrowser

from insights import commandcode_report

SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'UpdateHostKeys=no']
# Browser headers the server needs: CSRF, fetch metadata, compression and revalidation.
FORWARD = ('Content-Type', 'X-Forge-CSRF', 'Sec-Fetch-Site', 'Accept-Encoding', 'If-None-Match', 'Cache-Control')
# Hop-by-hop or rewritten here; everything else (ETag, Content-Encoding, Vary, Cache-Control...) passes back.
HOP = {'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authenticate',
       'proxy-authorization', 'server', 'date'}


def sync_commandcode(stop, args):
    cli = Path('/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI')
    if not cli.is_file():
        return
    publish = "from pathlib import Path; import os,sys; p=Path(sys.argv[1]); t=p.with_suffix('.incoming'); t.write_text(sys.stdin.read()); t.chmod(0o600); os.replace(t,p)"
    command = 'python3 -c ' + shlex.quote(publish) + ' ' + shlex.quote(args.state.rstrip('/') + '/commandcode-usage.json')
    while not stop.is_set():
        try:
            result = subprocess.run([str(cli), 'usage', '--provider', 'commandcode', '--source', 'web',
                '--format', 'json', '--web-timeout', '15'], capture_output=True, text=True, timeout=45, check=True)
            report = commandcode_report(json.loads(result.stdout))
            # SSH carries this allowlisted snapshot only, never the original CLI payload or cookies.
            subprocess.run([*SSH, args.host, command],
                input=json.dumps(report), text=True, capture_output=True, timeout=20, check=True)
        except Exception as error:
            # Keep the last snapshot (Forge marks it stale after 15 minutes) and keep this thread alive.
            print(f'Mana Tape: CommandCode sync: {type(error).__name__}', file=sys.stderr, flush=True)
        stop.wait(300)


class Upstream:
    """Keep-alive connections to the SSH tunnel: one TCP/SSH channel per browser burst, not per request."""

    def __init__(self, port, size=8, idle=20):
        # `idle` stays below the server's 30 s keep-alive timeout.
        self.port, self.size, self.idle = port, size, idle
        self.lock = threading.Lock()
        self.free = []

    def get(self):
        with self.lock:
            while self.free:
                connection, used = self.free.pop()
                if time.monotonic() - used < self.idle:
                    return connection, True
                connection.close()
        return http.client.HTTPConnection('127.0.0.1', self.port, timeout=30), False

    def put(self, connection):
        with self.lock:
            if len(self.free) < self.size:
                self.free.append((connection, time.monotonic()))
                return
        connection.close()

    def close(self):
        with self.lock:
            free, self.free = self.free, []
        for connection, _ in free:
            connection.close()


class Proxy(BaseHTTPRequestHandler):
    # Browser keep-alive; every response carries Content-Length or is a bodiless 304.
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def serve(self):
        allowed = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
        host = self.headers.get('Host', '')
        if (host not in allowed or self.headers.get('Origin', 'http://' + host) != 'http://' + host
                or self.headers.get('Sec-Fetch-Site') == 'cross-site'
                or not self.path.startswith('/') or self.path.startswith('//')):
            self.send_error(403)
            return
        if self.headers.get('Transfer-Encoding'):
            self.send_error(411)
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 <= size <= 200000:
                self.send_error(413)
                return
            body = self.rfile.read(size) if size else None
            headers = {name: self.headers[name] for name in FORWARD if self.headers.get(name)}
            headers.update({'Host': f'127.0.0.1:{self.server.remote_port}', 'X-Forge-Local': self.server.token})
            if self.headers.get('Origin'):
                headers['Origin'] = f'http://127.0.0.1:{self.server.remote_port}'
            connection, response = self.forward(body, headers)
        except (OSError, ValueError, http.client.HTTPException):
            self.send_error(502, 'Server unavailable. Restart this launcher.')
            return
        complete = False
        try:
            length = response.getheader('Content-Length')
            bodiless = response.status == 304 or 100 <= response.status < 200 or response.status == 204
            data = None if bodiless or length is not None else response.read()
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in HOP and not (data is not None and name.lower() == 'content-length'):
                    self.send_header(name, value)
            if data is not None:
                self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            if data is not None:
                self.wfile.write(data)
            elif bodiless:
                response.read()  # Marks the bodiless response done, so the connection can be reused.
            else:
                # Stream instead of buffering the whole body in the launcher.
                while chunk := response.read(65536):
                    self.wfile.write(chunk)
            complete = True
        except (OSError, http.client.HTTPException):
            self.close_connection = True
        finally:
            if complete and not response.will_close:
                self.server.upstream.put(connection)
            else:
                connection.close()

    def forward(self, body, headers):
        """Send over a pooled tunnel connection; a GET retries once if a reused one went stale."""
        for attempt in (0, 1):
            connection, reused = self.server.upstream.get()
            try:
                connection.request(self.command, self.path, body, headers)
                return connection, connection.getresponse()
            except (http.client.RemoteDisconnected, ConnectionResetError, BrokenPipeError):
                connection.close()
                # A POST is never repeated: the server may already have applied it.
                if not reused or attempt or self.command != 'GET':
                    raise
            except Exception:
                connection.close()
                raise

    do_GET = serve
    do_POST = serve


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=os.path.expanduser('~/.config/mana-tape/ssh.json'))
    parser.add_argument('--host')
    parser.add_argument('--state', help='Абсолютний шлях до стану першого проєкту на сервері')
    parser.add_argument('--remote-port', type=int)
    parser.add_argument('--port', type=int)
    parser.add_argument('--commandcode', action='store_true', default=None)
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()
    config = Path(args.config)
    defaults = json.loads(config.read_text(encoding='utf-8')) if config.is_file() else {}
    for name in ('host', 'state', 'port', 'remote_port', 'commandcode'):
        if getattr(args, name) is None:
            setattr(args, name, defaults.get(name, {'port': 19423, 'remote_port': 19421, 'commandcode': False}.get(name)))
    if not args.host or not args.state or args.host.startswith('-') or not args.state.startswith('/'):
        parser.error('Потрібні SSH host і абсолютний state через аргументи або ssh.json')
    # The token remains in this process, never in HTML, URLs, cookies or browser storage.
    token = subprocess.check_output([*SSH, args.host, 'cat -- ' + shlex.quote(args.state.rstrip('/') + '/local-token')], timeout=15).decode().strip()
    if len(token) < 32:
        raise RuntimeError('Missing private server access token')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        tunnel_port = probe.getsockname()[1]
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Proxy)
    server.daemon_threads = True
    server.token, server.tunnel_port, server.remote_port = token, tunnel_port, args.remote_port
    server.upstream = Upstream(tunnel_port)
    tunnel = subprocess.Popen([*SSH, '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
        '-N', '-L', f'127.0.0.1:{tunnel_port}:127.0.0.1:{args.remote_port}', args.host])
    stop = threading.Event()
    try:
        for _ in range(50):
            if tunnel.poll() is not None:
                raise RuntimeError('SSH tunnel could not start')
            try:
                with socket.create_connection(('127.0.0.1', tunnel_port), timeout=.2):
                    break
            except OSError:
                time.sleep(.2)
        else:
            raise RuntimeError('SSH tunnel timed out')
        url = f'http://127.0.0.1:{args.port}'
        print(f'Mana Tape: {url} (сервер через SSH; залиш це вікно відкритим)', flush=True)
        if args.commandcode:
            threading.Thread(target=sync_commandcode, args=(stop,args), daemon=True).start()
        if not args.no_open:
            webbrowser.open(url)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()
        server.upstream.close()
        tunnel.terminate()
        try:
            tunnel.wait(timeout=5)
        except subprocess.TimeoutExpired:
            tunnel.kill()
            tunnel.wait()


if __name__ == '__main__':
    main()
