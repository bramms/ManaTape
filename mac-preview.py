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
import time
import threading
import webbrowser

from insights import commandcode_report

SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'UpdateHostKeys=no']


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
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            pass  # Keep the last snapshot; Forge marks it stale after 15 minutes.
        stop.wait(300)


class Proxy(BaseHTTPRequestHandler):
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
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 <= size <= 200000:
                self.send_error(413)
                return
            body = self.rfile.read(size) if size else None
            headers = {name: self.headers[name] for name in ('Content-Type', 'X-Forge-CSRF', 'Sec-Fetch-Site') if self.headers.get(name)}
            headers.update({'Host': f'127.0.0.1:{self.server.remote_port}', 'X-Forge-Local': self.server.token})
            if self.headers.get('Origin'):
                headers['Origin'] = f'http://127.0.0.1:{self.server.remote_port}'
            connection = http.client.HTTPConnection('127.0.0.1', self.server.tunnel_port, timeout=30)
            try:
                connection.request(self.command, self.path, body, headers)
                response = connection.getresponse()
                data = response.read()
                self.send_response(response.status)
                for name, value in response.getheaders():
                    if name.lower() not in ('connection', 'transfer-encoding', 'server', 'date'):
                        self.send_header(name, value)
                self.end_headers()
                self.wfile.write(data)
            finally:
                connection.close()
        except (OSError, ValueError, http.client.HTTPException):
            self.send_error(502, 'Server unavailable. Restart this launcher.')

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
    defaults = json.loads(config.read_text()) if config.is_file() else {}
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
        tunnel.terminate()
        try:
            tunnel.wait(timeout=5)
        except subprocess.TimeoutExpired:
            tunnel.kill()
            tunnel.wait()


if __name__ == '__main__':
    main()
