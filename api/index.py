import json
import os
import sys
import urllib.parse

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from server import TimelineRequestHandler

class handler(TimelineRequestHandler):
    def do_GET(self):
        try:
            super().do_GET()
        except Exception as e:
            self.send_error_json(str(e))

    def do_POST(self):
        try:
            super().do_POST()
        except Exception as e:
            self.send_error_json(str(e))

    def send_error_json(self, err_msg):
        try:
            content = json.dumps({'error': err_msg, 'success': False}, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            self.wfile.flush()
        except Exception:
            pass

app = handler
