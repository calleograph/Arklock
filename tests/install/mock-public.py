#!/usr/bin/env python3
"""Управляемый «публичный адрес» для проверок scripts/lib/access.sh: HTTPS с собственным сертификатом и HTTP для «локального» приложения.
Сценарий выбирается переменной окружения MOCK_SCENARIO; порты и сертификат передаются аргументами."""
import json, os, ssl, sys, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

https_port, http_port, cert, key = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
scenario = os.environ.get("MOCK_SCENARIO", "good")
ACCESS = {
    "good": {"protocol": "https", "secure": True, "host": "localhost:%d" % https_port, "publicUrl": "https://localhost:%d" % https_port, "publicMatches": True, "forwardedProto": "https", "trustedProxyHops": 1, "firstUser": True},
    "no-proto": {"protocol": "http", "secure": False, "host": "localhost:%d" % https_port, "publicUrl": "https://localhost:%d" % https_port, "publicMatches": False, "forwardedProto": None, "trustedProxyHops": 1, "firstUser": True},
    "hops0": {"protocol": "http", "secure": False, "host": "localhost:%d" % https_port, "publicUrl": "https://localhost:%d" % https_port, "publicMatches": False, "forwardedProto": "https", "trustedProxyHops": 0, "firstUser": True},
    "host": {"protocol": "https", "secure": True, "host": "other.example:443", "publicUrl": "https://localhost:%d" % https_port, "publicMatches": False, "forwardedProto": "https", "trustedProxyHops": 1, "firstUser": False},
}
VERSION = {"name": "arklock", "version": "0.0.0", "commit": os.environ.get("MOCK_COMMIT", "abc123def456abc123def456abc123def4567890")}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if scenario == "html":
            return self.reply(200, b"<html>login</html>", "text/html")
        if self.path.startswith("/api/v1/access"):
            return self.reply(200, ACCESS.get(scenario, ACCESS["good"]))
        if self.path.startswith("/api/v1/version"):
            commit = "ffffffffffffffffffffffffffffffffffffffff" if scenario == "other" else VERSION["commit"]
            return self.reply(200, {**VERSION, "commit": commit} if self.server.server_port == https_port else VERSION)
        if self.path.startswith("/api/v1/ready"):
            return self.reply(200, {"status": "ready"})
        self.reply(404, {"error": "not found"})


secure = HTTPServer(("127.0.0.1", https_port), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert, key)
secure.socket = ctx.wrap_socket(secure.socket, server_side=True)
local = HTTPServer(("127.0.0.1", http_port), H)
threading.Thread(target=local.serve_forever, daemon=True).start()
print("ready", flush=True)
secure.serve_forever()
