import base64
import hashlib
import http.server
import json
import os
import secrets
import sys
import threading
import urllib.parse
import webbrowser
import requests

CLIENT_ID = os.environ["CLIENT_ID"]
CLIENT_SECRET = os.environ.get("CLIENT_SECRET", "")
REDIRECT_URI = "http://127.0.0.1:8977/callback"
SCOPES = "bookmark.read bookmark.write tweet.read users.read offline.access"

code_verifier = secrets.token_urlsafe(64)
code_challenge = base64.urlsafe_b64encode(
    hashlib.sha256(code_verifier.encode()).digest()
).rstrip(b"=").decode()
state = secrets.token_urlsafe(16)

auth_url = (
    "https://twitter.com/i/oauth2/authorize?"
    + urllib.parse.urlencode({
        "response_type": "code",
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    })
)

callback_result = {}
got_callback = threading.Event()

class CallbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/callback":
            params = urllib.parse.parse_qs(parsed.query)
            callback_result["code"] = params.get("code", [None])[0]
            callback_result["state"] = params.get("state", [None])[0]
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"Authorization complete. You may close this tab.")
            got_callback.set()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass

server = http.server.HTTPServer(("127.0.0.1", 8977), CallbackHandler)
server.timeout = 1

def serve_until_callback():
    while not got_callback.is_set():
        server.handle_request()

thread = threading.Thread(target=serve_until_callback, daemon=True)
thread.start()

print("Opening browser for authorization...")
webbrowser.open(auth_url)
got_callback.wait(timeout=300)
server.server_close()

if not callback_result.get("code"):
    print("ERROR: No authorization code received within 5 minutes.")
    raise SystemExit(1)

if callback_result["state"] != state:
    print("ERROR: State mismatch.")
    raise SystemExit(1)

token_resp = requests.post(
    "https://api.twitter.com/2/oauth2/token",
    data={
        "grant_type": "authorization_code",
        "code": callback_result["code"],
        "redirect_uri": REDIRECT_URI,
        "code_verifier": code_verifier,
        "client_id": CLIENT_ID,
    },
    auth=(CLIENT_ID, CLIENT_SECRET) if CLIENT_SECRET else None,
    headers={"Content-Type": "application/x-www-form-urlencoded"},
).json()

if "access_token" not in token_resp:
    print("ERROR:", token_resp)
    raise SystemExit(1)

print(f"\nX_OAUTH2_ACCESS_TOKEN={token_resp['access_token']}")
if "refresh_token" in token_resp:
    print(f"X_OAUTH2_REFRESH_TOKEN={token_resp['refresh_token']}")
