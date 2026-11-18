from __future__ import annotations

import json
import re

from http.client import HTTPConnection
from typing_extensions import Any, NamedTuple
from urllib.parse import urlsplit


HOSTS_LOOPBACK = frozenset({'127.0.0.1', 'localhost'})
METHOD_PATTERN = re.compile(r'[!#$%&\'*+.^_`|~0-9A-Za-z-]+')
TIMEOUT_SECONDS_DEFAULT = 30.0


class Reply(NamedTuple):
    body: bytes
    status: int

    def json(self) -> Any:
        return json.loads(self.body)


def http_request(
    url: str,
    *,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    method: str = 'GET',
    timeout: float = TIMEOUT_SECONDS_DEFAULT,
) -> Reply:
    if '://' not in url:
        message = f'url must be absolute: {url!r}'
        raise ValueError(message)

    if not isinstance(body, bytes | None):
        message = f'body must be bytes or None, not {type(body).__name__}'
        raise TypeError(message)

    if not isinstance(headers, dict | None):
        message = f'headers must be a dict or None, not {type(headers).__name__}'
        raise TypeError(message)

    if METHOD_PATTERN.fullmatch(method) is None:
        message = f'method must be an HTTP method token: {method!r}'
        raise ValueError(message)

    if timeout <= 0:
        message = f'timeout must be positive: {timeout}'
        raise ValueError(message)

    parts = urlsplit(url)

    if parts.scheme != 'http':
        message = f'the world speaks plain http on loopback only, not {url!r}'
        raise ValueError(message)

    if parts.hostname not in HOSTS_LOOPBACK:
        message = f'the world reaches loopback addresses with a port only, not {url!r}'
        raise ValueError(message)

    if parts.port is None:
        message = f'the world reaches loopback addresses with a port only, not {url!r}'
        raise ValueError(message)

    path = parts.path or '/'

    if parts.query:
        path = f'{path}?{parts.query}'

    connection = HTTPConnection(parts.hostname, parts.port, timeout=timeout)

    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        reply = Reply(body=response.read(), status=response.status)
    finally:
        connection.close()

    return reply


def http_json(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    method: str = 'GET',
    payload: object = None,
) -> Reply:
    if '://' not in url:
        message = f'url must be absolute: {url!r}'
        raise ValueError(message)

    if not isinstance(headers, dict | None):
        message = f'headers must be a dict or None, not {type(headers).__name__}'
        raise TypeError(message)

    if METHOD_PATTERN.fullmatch(method) is None:
        message = f'method must be an HTTP method token: {method!r}'
        raise ValueError(message)

    if not isinstance(payload, dict | list | tuple | str | int | float | None):
        message = f'payload must be JSON data or None, not {type(payload).__name__}'
        raise TypeError(message)

    body = None if payload is None else json.dumps(payload).encode()
    sent = {'Content-Type': 'application/json', **(headers or {})}

    return http_request(url, body=body, headers=sent, method=method)
