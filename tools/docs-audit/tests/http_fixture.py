"""Loopback-only HTTP responses for real lychee integration tests; stdlib only."""
import http.server
import time


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/timeout":
            time.sleep(3)
            status = 200
        else:
            status = int(self.path.strip("/"))
        self.send_response(status)
        self.end_headers()

    def log_message(self, *_):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
