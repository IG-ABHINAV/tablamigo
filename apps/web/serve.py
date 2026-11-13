#!/usr/bin/env python3
"""Local preview of dist/ with the same clean URLs nginx serves (try_files $uri $uri.html)."""
import http.server, os, sys
DIST = os.environ.get('TABLAMIGO_WEB_DIST') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dist')
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=DIST, **k)
    def send_head(self):
        p = self.path.split('?')[0]
        if p != '/' and not os.path.splitext(p)[1] and os.path.exists(DIST + p + '.html'):
            self.path = p + '.html'
        elif p != '/' and not os.path.exists(DIST + p):
            self.path = '/404.html'
        return super().send_head()
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 5199), H).serve_forever()
