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
            if args.local_state:
                # The Mac's own Mana Tape reads the same snapshot from its state directory.
                local = Path(os.path.expanduser(args.local_state)) / 'commandcode-usage.json'
                incoming = local.with_suffix('.incoming')
                incoming.write_text(json.dumps(report)); incoming.chmod(0o600); os.replace(incoming, local)
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
        return self.fresh(), False

    def fresh(self):
        return http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)

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


class Token:
    """The server's local token, read through SSH. A server restart writes a new one; a 403 reads it again (at most
    every two seconds), so a restarted server never needs a restarted launcher."""

    def __init__(self, read, value=None):
        self.read, self.lock, self.at = read, threading.Lock(), 0.0
        self.value = value if value is not None else self.fetch()

    def fetch(self):
        value = self.read()
        if len(value) < 32:
            raise RuntimeError('Missing private server access token')
        return value

    def renew(self, used):
        """True when a different token is now in use (read now or by another request meanwhile)."""
        with self.lock:
            if self.value != used:
                return True
            if time.monotonic() - self.at < 2:
                return False
            self.at = time.monotonic()
            try:
                value = self.fetch()
            except Exception as error:
                print(f'Mana Tape: token: {type(error).__name__}', file=sys.stderr, flush=True)
                return False
            changed, self.value = value != used, value
            return changed


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
            token = self.server.token
            headers.update({'Host': f'127.0.0.1:{self.server.remote_port}', 'X-Forge-Local': token.value})
            if self.headers.get('Origin'):
                headers['Origin'] = f'http://127.0.0.1:{self.server.remote_port}'
            connection, response = self.forward(body, headers)
            if response.status == 403 and token.renew(headers['X-Forge-Local']):
                # The server restarted with a new token. A 403 is a refusal before anything ran, so the request,
                # a POST included, is sent once more with the new token.
                response.read()
                if response.will_close:
                    connection.close()
                else:
                    self.server.upstream.put(connection)
                headers['X-Forge-Local'] = token.value
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
        """Send over a pooled tunnel connection. After a tunnel blip every pooled connection is
        stale, so any failure flushes the whole pool, and a GET is retried once on a fresh one."""
        upstream = self.server.upstream
        connection, reused = upstream.get()
        for attempt in (0, 1):
            try:
                connection.request(self.command, self.path, body, headers)
                return connection, connection.getresponse()
            except Exception as error:
                connection.close()
                upstream.close()
                # A POST is never repeated: the server may already have applied it. A timeout is not
                # retried either (it would only double the wait); a refused fresh connection means
                # the tunnel is down, not stale.
                if attempt or self.command != 'GET' or isinstance(error, (TimeoutError, socket.timeout)) or not reused and isinstance(error, ConnectionRefusedError):
                    raise
                connection = upstream.fresh()

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
    parser.add_argument('--local-state', dest='local_state', help='Каталог стану локальної Mana Tape для того ж знімка CodexBar')
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()
    config = Path(args.config)
    defaults = json.loads(config.read_text(encoding='utf-8')) if config.is_file() else {}
    for name in ('host', 'state', 'port', 'remote_port', 'commandcode', 'local_state'):
        if getattr(args, name) is None:
            setattr(args, name, defaults.get(name, {'port': 19423, 'remote_port': 19421, 'commandcode': False}.get(name)))
    if not args.host or not args.state or args.host.startswith('-') or not args.state.startswith('/'):
        parser.error('Потрібні SSH host і абсолютний state через аргументи або ssh.json')
    # The token remains in this process, never in HTML, URLs, cookies or browser storage.
    def read_token():
        return subprocess.check_output([*SSH, args.host, 'cat -- ' + shlex.quote(args.state.rstrip('/') + '/local-token')], timeout=15).decode().strip()
    token = Token(read_token)
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        tunnel_port = probe.getsockname()[1]
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Proxy)
    server.daemon_threads = True
    server.token, server.tunnel_port, server.remote_port = token, tunnel_port, args.remote_port
    server.upstream = Upstream(tunnel_port)

    def open_tunnel():
        process = subprocess.Popen([*SSH, '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
            '-N', '-L', f'127.0.0.1:{tunnel_port}:127.0.0.1:{args.remote_port}', args.host])
        for _ in range(50):
            if process.poll() is not None:
                return process, False
            try:
                with socket.create_connection(('127.0.0.1', tunnel_port), timeout=.2):
                    return process, True
            except OSError:
                time.sleep(.2)
        return process, False

    def watch_tunnel():
        """A network drop ends the SSH process while this proxy keeps listening (every request would be 502):
        reopen the tunnel with growing pauses and drop the pooled connections that went through the dead one."""
        pause = 2
        while not stop.wait(5):
            if current['tunnel'].poll() is None:
                pause = 2
                continue
            print('Mana Tape: SSH tunnel closed; reconnecting', file=sys.stderr, flush=True)
            server.upstream.close()
            while not stop.is_set():
                process, ready = open_tunnel()
                current['tunnel'] = process
                if ready:
                    print('Mana Tape: SSH tunnel restored', file=sys.stderr, flush=True)
                    break
                process.terminate()
                stop.wait(pause)
                pause = min(pause * 2, 60)

    stop = threading.Event()
    tunnel, ready = open_tunnel()
    current = {'tunnel': tunnel}
    try:
        if not ready:
            raise RuntimeError('SSH tunnel could not start' if tunnel.poll() is not None else 'SSH tunnel timed out')
        threading.Thread(target=watch_tunnel, daemon=True).start()
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
        tunnel = current['tunnel']
        tunnel.terminate()
        try:
            tunnel.wait(timeout=5)
        except subprocess.TimeoutExpired:
            tunnel.kill()
            tunnel.wait()


if __name__ == '__main__':
    main()
