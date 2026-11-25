#!/usr/bin/env python3
"""Run this complete folder locally. Python standard library only."""
import argparse
import functools
import http.server
import threading
import webbrowser
from pathlib import Path


class FreshFiles(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.geojson': 'application/geo+json; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.glb': 'model/gltf-binary',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description='MetroRookies 발표 화면 v7 로컬 서버')
    parser.add_argument('--port', type=int, default=8081)
    parser.add_argument('--no-open', action='store_true', help='브라우저를 자동으로 열지 않음')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('포트는 1–65535 범위여야 합니다.')
    root = Path(__file__).resolve().parent
    handler = functools.partial(FreshFiles, directory=str(root))
    try:
        server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    except OSError as error:
        print(f'서버를 열지 못했습니다: {error}')
        print(f'기존 {args.port} 서버의 창에서 Ctrl+C를 누르고 다시 실행하세요.')
        print('다른 포트를 쓰면 V-World / Kakao에 등록한 접속 주소도 일치해야 합니다.')
        return 1
    url = f'http://localhost:{args.port}/'
    print('\nMetroRookies · 발표 화면 v7')
    print(f'프로젝트 폴더: {root}')
    print(f'접속 주소: {url}')
    print('서버를 사용하는 동안 이 창을 열어 두세요. 종료: Ctrl+C\n')
    if not args.no_open:
        timer = threading.Timer(.6, lambda: webbrowser.open(url))
        timer.daemon = True
        timer.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n서버를 종료합니다.')
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
