import copy
import http.server
import logging
import os
import socketserver
import threading
import time
import urllib.parse
import webbrowser
from pathlib import Path

import httpx
import requests
from fastmcp import FastMCP
from oauthlib.oauth1 import Client as OAuth1Client
from requests_oauthlib import OAuth1Session

HTTP_METHODS = {
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "options",
    "head",
    "trace",
}

LOGGER = logging.getLogger("xmcp.x_api")
OAUTH_LOGGER = logging.getLogger("xmcp.oauth1")

REQUEST_TOKEN_URL = "https://api.x.com/oauth/request_token"
AUTHORIZE_URL = "https://api.x.com/oauth/authorize"
ACCESS_TOKEN_URL = "https://api.x.com/oauth/access_token"
OAUTH2_TOKEN_URL = "https://api.twitter.com/2/oauth2/token"
OAUTH2_REFRESH_THRESHOLD_SECS = 300


class OAuth2TokenManager:
    def __init__(self, access_token: str, refresh_token: str, client_id: str, client_secret: str):
        self.access_token = access_token
        self.refresh_token = refresh_token
        self.client_id = client_id
        self.client_secret = client_secret
        self.expires_at = 0.0
        self._lock = threading.Lock()

    def get_token(self) -> str:
        with self._lock:
            if time.time() > self.expires_at - OAUTH2_REFRESH_THRESHOLD_SECS:
                self._refresh()
            return self.access_token

    def _refresh(self) -> None:
        LOGGER.info("Refreshing OAuth2 access token")
        resp = requests.post(
            OAUTH2_TOKEN_URL,
            auth=(self.client_id, self.client_secret),
            data={
                "grant_type": "refresh_token",
                "refresh_token": self.refresh_token,
                "client_id": self.client_id,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        self.access_token = data["access_token"]
        if "refresh_token" in data:
            self.refresh_token = data["refresh_token"]
        self.expires_at = time.time() + data.get("expires_in", 7200)
        self._persist()

    def _persist(self) -> None:
        env_path = Path(__file__).resolve().parent / ".env"
        if not env_path.exists():
            return
        lines = env_path.read_text().splitlines(keepends=True)
        out: list[str] = []
        seen = {"X_OAUTH2_ACCESS_TOKEN": False, "X_OAUTH2_REFRESH_TOKEN": False}
        for line in lines:
            if line.startswith("X_OAUTH2_ACCESS_TOKEN="):
                out.append(f"X_OAUTH2_ACCESS_TOKEN={self.access_token}\n")
                seen["X_OAUTH2_ACCESS_TOKEN"] = True
            elif line.startswith("X_OAUTH2_REFRESH_TOKEN="):
                out.append(f"X_OAUTH2_REFRESH_TOKEN={self.refresh_token}\n")
                seen["X_OAUTH2_REFRESH_TOKEN"] = True
            else:
                out.append(line)
        if not seen["X_OAUTH2_ACCESS_TOKEN"]:
            out.append(f"X_OAUTH2_ACCESS_TOKEN={self.access_token}\n")
        if not seen["X_OAUTH2_REFRESH_TOKEN"]:
            out.append(f"X_OAUTH2_REFRESH_TOKEN={self.refresh_token}\n")
        tmp = env_path.with_name(env_path.name + ".tmp")
        tmp.write_text("".join(out))
        tmp.replace(env_path)
        os.environ["X_OAUTH2_ACCESS_TOKEN"] = self.access_token
        os.environ["X_OAUTH2_REFRESH_TOKEN"] = self.refresh_token


def is_truthy(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def parse_csv_env(key: str) -> set[str]:
    raw = os.getenv(key, "")
    if not raw.strip():
        return set()
    return {item.strip() for item in raw.split(",") if item.strip()}


def should_join_query_param(param: dict) -> bool:
    if param.get("in") != "query":
        return False
    schema = param.get("schema", {})
    if schema.get("type") != "array":
        return False
    return param.get("explode") is False


def collect_comma_params(spec: dict) -> set[str]:
    comma_params: set[str] = set()
    components = spec.get("components", {}).get("parameters", {})
    for param in components.values():
        if isinstance(param, dict) and should_join_query_param(param):
            name = param.get("name")
            if isinstance(name, str):
                comma_params.add(name)

    for item in spec.get("paths", {}).values():
        if not isinstance(item, dict):
            continue
        for method, operation in item.items():
            if method.lower() not in HTTP_METHODS or not isinstance(operation, dict):
                continue
            for param in operation.get("parameters", []):
                if not isinstance(param, dict) or "$ref" in param:
                    continue
                if should_join_query_param(param):
                    name = param.get("name")
                    if isinstance(name, str):
                        comma_params.add(name)

    return comma_params


def load_openapi_spec() -> dict:
    url = "https://api.x.com/2/openapi.json"
    LOGGER.info("Fetching OpenAPI spec from %s", url)
    response = requests.get(url, timeout=30)
    response.raise_for_status()
    return response.json()


def _get_env_int(key: str, default: int) -> int:
    raw = os.getenv(key, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        raise RuntimeError(f"{key} must be an integer value.")


def _callback_url(host: str, port: int, path: str) -> str:
    return f"http://{host}:{port}{path}"


def _wait_for_callback(host: str, port: int, path: str, timeout_seconds: int) -> tuple[str, str]:
    params: dict[str, str | None] = {"oauth_token": None, "oauth_verifier": None}
    event = threading.Event()

    class _Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != path:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"Not found.")
                return
            query = urllib.parse.parse_qs(parsed.query)
            params["oauth_token"] = (query.get("oauth_token") or [None])[0]
            params["oauth_verifier"] = (query.get("oauth_verifier") or [None])[0]
            event.set()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"OAuth complete. You may close this tab.")

        def log_message(self, format: str, *args: object) -> None:  # noqa: A003
            OAUTH_LOGGER.debug("OAuth1 callback: " + format, *args)

    class _Server(socketserver.TCPServer):
        allow_reuse_address = True

    server = _Server((host, port), _Handler)
    server.timeout = 1

    deadline = time.time() + timeout_seconds
    try:
        while time.time() < deadline:
            server.handle_request()
            if event.is_set():
                break
    finally:
        server.server_close()

    oauth_token = params.get("oauth_token")
    oauth_verifier = params.get("oauth_verifier")
    if not oauth_token or not oauth_verifier:
        raise TimeoutError("OAuth callback not received before timeout.")
    return oauth_token, oauth_verifier


def run_oauth1_flow() -> tuple[str, str]:
    consumer_key = os.getenv("X_OAUTH_CONSUMER_KEY")
    consumer_secret = os.getenv("X_OAUTH_CONSUMER_SECRET")
    if not consumer_key or not consumer_secret:
        raise RuntimeError(
            "Missing X_OAUTH_CONSUMER_KEY or X_OAUTH_CONSUMER_SECRET for OAuth1 flow."
        )

    callback_host = os.getenv("X_OAUTH_CALLBACK_HOST", "127.0.0.1")
    callback_port = _get_env_int("X_OAUTH_CALLBACK_PORT", 8976)
    callback_path = os.getenv("X_OAUTH_CALLBACK_PATH", "/oauth/callback")
    callback_timeout = _get_env_int("X_OAUTH_CALLBACK_TIMEOUT", 300)

    callback_url = _callback_url(callback_host, callback_port, callback_path)

    oauth = OAuth1Session(
        client_key=consumer_key,
        client_secret=consumer_secret,
        callback_uri=callback_url,
    )
    request_token = oauth.fetch_request_token(REQUEST_TOKEN_URL)
    resource_owner_key = request_token.get("oauth_token")
    resource_owner_secret = request_token.get("oauth_token_secret")
    if not resource_owner_key or not resource_owner_secret:
        raise RuntimeError("Failed to obtain OAuth request token.")

    authorization_url = oauth.authorization_url(AUTHORIZE_URL)
    OAUTH_LOGGER.info("Opening browser for OAuth1 consent.")
    webbrowser.open(authorization_url)

    oauth_token, oauth_verifier = _wait_for_callback(
        callback_host, callback_port, callback_path, callback_timeout
    )
    if oauth_token != resource_owner_key:
        raise RuntimeError("OAuth callback token does not match request token.")

    oauth = OAuth1Session(
        client_key=consumer_key,
        client_secret=consumer_secret,
        resource_owner_key=resource_owner_key,
        resource_owner_secret=resource_owner_secret,
        verifier=oauth_verifier,
    )
    access_token = oauth.fetch_access_token(ACCESS_TOKEN_URL)
    access_key = access_token.get("oauth_token")
    access_secret = access_token.get("oauth_token_secret")
    if not access_key or not access_secret:
        raise RuntimeError("Failed to obtain OAuth access token.")
    return access_key, access_secret


def load_env() -> None:
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.exists():
        return
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv(env_path, override=True)


def setup_logging() -> bool:
    debug_enabled = is_truthy(os.getenv("X_API_DEBUG", "1"))
    if debug_enabled:
        logging.basicConfig(level=logging.INFO)
        LOGGER.setLevel(logging.INFO)
    return debug_enabled


def should_exclude_operation(path: str, operation: dict) -> bool:
    if "/webhooks" in path or "/stream" in path:
        return True

    tags = [tag.lower() for tag in operation.get("tags", []) if isinstance(tag, str)]
    if "stream" in tags or "webhooks" in tags:
        return True

    if operation.get("x-twitter-streaming") is True:
        return True

    return False


def filter_openapi_spec(spec: dict) -> dict:
    filtered = copy.deepcopy(spec)
    paths = filtered.get("paths", {})
    new_paths = {}
    allow_tags = {tag.lower() for tag in parse_csv_env("X_API_TOOL_TAGS")}
    allow_ops = parse_csv_env("X_API_TOOL_ALLOWLIST")
    deny_ops = parse_csv_env("X_API_TOOL_DENYLIST")

    for path, item in paths.items():
        if not isinstance(item, dict):
            continue

        new_item = {}
        for key, value in item.items():
            if key.lower() in HTTP_METHODS:
                if should_exclude_operation(path, value):
                    continue
                operation_id = value.get("operationId")
                operation_tags = [
                    tag.lower() for tag in value.get("tags", []) if isinstance(tag, str)
                ]
                if allow_tags and not (set(operation_tags) & allow_tags):
                    continue
                if allow_ops and operation_id not in allow_ops:
                    continue
                if deny_ops and operation_id in deny_ops:
                    continue
                new_item[key] = value
            else:
                new_item[key] = value

        if any(method.lower() in HTTP_METHODS for method in new_item.keys()):
            new_paths[path] = new_item

    filtered["paths"] = new_paths
    return filtered


def print_tool_list(spec: dict) -> None:
    tools: list[str] = []
    for path, item in spec.get("paths", {}).items():
        if not isinstance(item, dict):
            continue
        for method, operation in item.items():
            if method.lower() not in HTTP_METHODS or not isinstance(operation, dict):
                continue
            op_id = operation.get("operationId")
            if op_id:
                tools.append(op_id)
            else:
                tools.append(f"{method.upper()} {path}")

    tools.sort()
    print(f"Loaded {len(tools)} tools from OpenAPI:")
    for tool in tools:
        print(f"- {tool}")


def get_auth_headers(oauth_token: str | None = None) -> dict:
    env_oauth_token = os.getenv("X_OAUTH_ACCESS_TOKEN", "").strip()
    bearer_token = os.getenv("X_BEARER_TOKEN", "").strip()
    token = oauth_token or env_oauth_token or bearer_token
    if not token:
        raise RuntimeError("Set X_BEARER_TOKEN or provide OAuth1 access token on startup.")
    return {"Authorization": f"Bearer {token}"}


def build_oauth1_client() -> OAuth1Client:
    consumer_key = os.getenv("X_OAUTH_CONSUMER_KEY")
    consumer_secret = os.getenv("X_OAUTH_CONSUMER_SECRET")
    if not consumer_key or not consumer_secret:
        raise RuntimeError(
            "Missing X_OAUTH_CONSUMER_KEY or X_OAUTH_CONSUMER_SECRET for OAuth1 signing."
        )
    access_token = os.getenv("X_OAUTH_ACCESS_TOKEN", "").strip()
    access_secret = os.getenv("X_OAUTH_ACCESS_TOKEN_SECRET", "").strip()
    if not access_token or not access_secret:
        access_token, access_secret = run_oauth1_flow()
    if is_truthy(os.getenv("X_OAUTH_PRINT_TOKENS", "0")):
        print("OAuth1 access token:", access_token)
        print("OAuth1 access token secret:", access_secret)
    LOGGER.info("OAuth1 access token: %s", access_token)
    return OAuth1Client(
        client_key=consumer_key,
        client_secret=consumer_secret,
        resource_owner_key=access_token,
        resource_owner_secret=access_secret,
        signature_type="AUTH_HEADER",
    )


def print_oauth1_header_probe(oauth1_client: OAuth1Client, base_url: str) -> None:
    probe_url = f"{base_url}/2/users/me"
    _, signed_headers, _ = oauth1_client.sign(
        probe_url,
        http_method="GET",
        headers={},
    )
    auth_header = signed_headers.get("Authorization")
    if auth_header:
        print("OAuth1 Authorization header (sample GET /2/users/me):", auth_header)
    else:
        print("OAuth1 Authorization header missing from signed probe request.")


def create_mcp() -> FastMCP:
    load_env()
    debug_enabled = setup_logging()
    parser_flag = os.getenv("FASTMCP_EXPERIMENTAL_ENABLE_NEW_OPENAPI_PARSER")
    if parser_flag is not None:
        os.environ["FASTMCP_EXPERIMENTAL_ENABLE_NEW_OPENAPI_PARSER"] = parser_flag

    base_url = os.getenv("X_API_BASE_URL", "https://api.x.com")
    timeout = float(os.getenv("X_API_TIMEOUT", "30"))

    oauth2_token = os.getenv("X_OAUTH2_ACCESS_TOKEN", "").strip()
    oauth2_refresh = os.getenv("X_OAUTH2_REFRESH_TOKEN", "").strip()
    oauth2_client_id = os.getenv("X_OAUTH2_CLIENT_ID", "").strip()
    oauth2_client_secret = os.getenv("X_OAUTH2_CLIENT_SECRET", "").strip()
    print_oauth_header = is_truthy(os.getenv("X_OAUTH_PRINT_AUTH_HEADER", "0"))

    oauth2_manager: OAuth2TokenManager | None = None
    if oauth2_token:
        if oauth2_refresh and oauth2_client_id and oauth2_client_secret:
            oauth2_manager = OAuth2TokenManager(
                access_token=oauth2_token,
                refresh_token=oauth2_refresh,
                client_id=oauth2_client_id,
                client_secret=oauth2_client_secret,
            )
            oauth2_manager.get_token()
            LOGGER.info("Using OAuth 2.0 bearer token with auto-refresh.")
        else:
            LOGGER.info("Using OAuth 2.0 bearer token (no refresh configured).")
        auth_hook_name = "add_oauth2_bearer"
    else:
        oauth1_client = build_oauth1_client()
        if print_oauth_header:
            print_oauth1_header_probe(oauth1_client, base_url)
        auth_hook_name = "sign_oauth1_request"

    spec = load_openapi_spec()
    filtered_spec = filter_openapi_spec(spec)
    comma_params = collect_comma_params(filtered_spec)
    print_tool_list(filtered_spec)

    async def normalize_query_params(request: httpx.Request) -> None:
        if not comma_params:
            return
        params = list(request.url.params.multi_items())
        grouped: dict[str, list[str]] = {}
        ordered: list[str] = []
        normalized: list[tuple[str, str]] = []

        for key, value in params:
            if key in comma_params:
                if key not in grouped:
                    ordered.append(key)
                grouped.setdefault(key, []).append(value)
            else:
                normalized.append((key, value))

        if not grouped:
            return

        for key in ordered:
            values: list[str] = []
            for raw in grouped[key]:
                for part in raw.split(","):
                    part = part.strip()
                    if part and part not in values:
                        values.append(part)
            if values:
                normalized.append((key, ",".join(values)))

        request.url = request.url.copy_with(params=normalized)

    b3_flags = os.getenv("X_B3_FLAGS", "1")

    async def add_oauth2_bearer(request: httpx.Request) -> None:
        token = oauth2_manager.get_token() if oauth2_manager else oauth2_token
        request.headers["Authorization"] = f"Bearer {token}"
        request.headers["X-B3-Flags"] = b3_flags

    async def sign_oauth1_request(request: httpx.Request) -> None:
        request.headers["X-B3-Flags"] = b3_flags
        headers = dict(request.headers)
        content_type = headers.get("Content-Type", "")
        body: str | None = None
        if content_type.startswith("application/x-www-form-urlencoded"):
            body_bytes = request.content or b""
            body = body_bytes.decode("utf-8")
        signed_url, signed_headers, _ = oauth1_client.sign(
            str(request.url),
            http_method=request.method,
            body=body,
            headers=headers,
        )
        request.url = httpx.URL(signed_url)
        request.headers.update(signed_headers)
        if print_oauth_header:
            auth_header = signed_headers.get("Authorization")
            if auth_header:
                print("OAuth1 Authorization header:", auth_header)
            else:
                print("OAuth1 Authorization header missing from signed request.")

    auth_hook = add_oauth2_bearer if oauth2_token else sign_oauth1_request

    async def log_request(request: httpx.Request) -> None:
        if not debug_enabled:
            return
        LOGGER.info("X API request %s %s", request.method, request.url)

    async def log_response(response: httpx.Response) -> None:
        if not debug_enabled:
            return
        LOGGER.info(
            "X API response %s %s -> %s",
            response.request.method,
            response.request.url,
            response.status_code,
        )
        if response.status_code >= 400:
            transaction_id = response.headers.get("x-transaction-id")
            if transaction_id:
                LOGGER.warning("X API x-transaction-id: %s", transaction_id)
            body = await response.aread()
            text = body.decode("utf-8", errors="replace")
            if len(text) > 1000:
                text = text[:1000] + "...<truncated>"
            LOGGER.warning("X API error body: %s", text)

    client = httpx.AsyncClient(
        base_url=base_url,
        headers={},
        timeout=timeout,
        event_hooks={
            "request": [normalize_query_params, auth_hook, log_request],
            "response": [log_response],
        },
    )
    return FastMCP.from_openapi(
        openapi_spec=filtered_spec,
        client=client,
        name="X API MCP",
    )


def main() -> None:
    mcp = create_mcp()
    transport = os.getenv("MCP_TRANSPORT", "http")
    if transport == "stdio":
        mcp.run(transport="stdio")
    else:
        host = os.getenv("MCP_HOST", "127.0.0.1")
        port = int(os.getenv("MCP_PORT", "8000"))
        mcp.run(transport="http", host=host, port=port)


if __name__ == "__main__":
    main()
