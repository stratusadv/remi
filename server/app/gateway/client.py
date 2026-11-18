from __future__ import annotations

import http.client
import json
import logging
import queue
import secrets
import threading

from types import MappingProxyType
from typing_extensions import TYPE_CHECKING
from urllib.parse import urlsplit

from django.conf import settings
from django.db import connection
from django.http import HttpResponse, StreamingHttpResponse

from app.core.exceptions import (
    GatewayBusyError,
    GatewayRefusedError,
    GatewayUnavailableError,
    RequestInvalidError,
)
from app.gateway.constants import (
    GATEWAY_ERROR_DETAIL_BYTES,
    GATEWAY_FIELD_COUNT_MAX,
    GATEWAY_FIELD_NAME_PATTERN,
    GATEWAY_FIELD_VALUE_BYTES_MAX,
    GATEWAY_HEARTBEAT_SECONDS,
    GATEWAY_REPLY_BYTES_MAX,
    GATEWAY_STREAM_PIECE_BYTES,
    GATEWAY_STREAM_PIECE_COUNT_MAX,
    GATEWAY_TIMEOUT_SECONDS,
    MODEL_CHAT,
    PATH_CHAT,
    PATH_EMBEDDINGS,
    PATH_TRANSCRIPTION,
)
from app.gateway.flac import FLAC_MARKER

if TYPE_CHECKING:
    from collections.abc import Iterator

    from app.core.exceptions import BillingError


BOUNDARY_BYTES = 16
CONTENT_TYPE_EVENT_STREAM = 'text/event-stream'
CONTENT_TYPE_JSON = 'application/json'
PUMP_END = b''
PUMP_QUEUE_CAPACITY = GATEWAY_STREAM_PIECE_COUNT_MAX + 1
SSE_DATA_PREFIX = 'data:'
SSE_DONE = '[DONE]'
STATUS_SUCCESS_FIRST = 200
STATUS_SUCCESS_LAST = 299
STATUS_TOO_MANY_REQUESTS = 429
STATUSES_REFUSED = frozenset({400, 404, 413, 415, 422})
STREAM_HEARTBEAT = b': keep-alive\n\n'
STREAM_OPENING = b': remi\n\n'
UNAVAILABLE_MESSAGE = 'The AI service is unavailable. Try again in a minute.'
WHOLE_HEARTBEAT = b'\n'
logger = logging.getLogger(__name__)

CONNECTION_CLASSES = MappingProxyType({
    'http': http.client.HTTPConnection,
    'https': http.client.HTTPSConnection,
})


def _completion_assemble(raw: bytes) -> bytes:
    if len(raw) > GATEWAY_REPLY_BYTES_MAX:
        message = f'an assembled reply holds at most {GATEWAY_REPLY_BYTES_MAX} bytes: {len(raw)}'
        raise ValueError(message)

    parts: list[str] = []
    usage: object = None

    for line in raw.decode(errors='replace').splitlines():
        event = _event_read(line)

        if event is None:
            continue

        if 'error' in event:
            failure = {'error': event['error']}
            return json.dumps(failure).encode()

        usage = event.get('usage') or usage
        parts.append(_delta_text(event))

    message = {'content': ''.join(parts), 'role': 'assistant'}
    choice = {'finish_reason': 'stop', 'index': 0, 'message': message}
    completion = {'choices': [choice], 'object': 'chat.completion', 'usage': usage}

    return json.dumps(completion).encode()


def _database_release() -> None:
    if connection.in_atomic_block:
        return

    connection.close()


def _delta_text(event: dict[str, object]) -> str:
    if 'error' in event:
        message = 'an error event carries no delta text'
        raise ValueError(message)

    choices = event.get('choices')

    if not isinstance(choices, list):
        return ''

    if not choices:
        return ''

    first = choices[0]
    delta = first.get('delta') if isinstance(first, dict) else None

    if not isinstance(delta, dict):
        return ''

    content = delta.get('content')

    return content if isinstance(content, str) else ''


def _event_read(line: str) -> dict[str, object] | None:
    if '\n' in line:
        message = 'an event line carries no line break'
        raise ValueError(message)

    if not line.startswith(SSE_DATA_PREFIX):
        return None

    payload = line.removeprefix(SSE_DATA_PREFIX).strip()

    if payload in ('', SSE_DONE):
        return None

    try:
        event = json.loads(payload)
    except ValueError:
        logger.warning('an AI stream carried an event that is not JSON')
        return None

    if not isinstance(event, dict):
        logger.warning('an AI stream carried an event that is not an object')
        return None

    return event


def _gateway_open(
    *,
    body: bytes,
    content_type: str,
    key: str,
    path: str,
) -> http.client.HTTPResponse:
    if body == b'':
        message = 'the AI service is sent a body'
        raise ValueError(message)

    if '/' not in content_type:
        message = f'content_type must name a media type: {content_type!r}'
        raise ValueError(message)

    if not isinstance(key, str):
        message = f'key must be a str: {type(key).__name__}'
        raise TypeError(message)

    if not path.startswith('/'):
        message = f'path must start with a slash: {path!r}'
        raise ValueError(message)

    address = urlsplit(settings.REMI_API_HOST.strip())
    connection_class = CONNECTION_CLASSES.get(address.scheme)

    if connection_class is None:
        logger.error('REMI_API_HOST must be an http or https address')
        raise GatewayUnavailableError(UNAVAILABLE_MESSAGE)

    if address.netloc == '':
        logger.error('REMI_API_HOST must name a host')
        raise GatewayUnavailableError(UNAVAILABLE_MESSAGE)

    if key == '':
        logger.error('the AI service key for %s is not set', path)
        raise GatewayUnavailableError(UNAVAILABLE_MESSAGE)

    upstream = connection_class(address.netloc, timeout=GATEWAY_TIMEOUT_SECONDS)

    _database_release()

    try:
        headers = {
            'Authorization': f'Bearer {key}',
            'Connection': 'close',
            'Content-Type': content_type,
        }

        target = address.path.rstrip('/') + path

        upstream.request('POST', target, body=body, headers=headers)
        reply = upstream.getresponse()
    except (OSError, http.client.HTTPException):
        upstream.close()
        logger.exception('the AI service could not be reached for %s', path)

        message = 'remi could not reach its AI service. Try again in a minute.'
        raise GatewayUnavailableError(message) from None

    if STATUS_SUCCESS_FIRST <= reply.status <= STATUS_SUCCESS_LAST:
        return reply

    status = reply.status
    detail = _reply_detail(reply)

    reply.close()
    upstream.close()

    raise _gateway_refusal(detail=detail, path=path, status=status)


def _gateway_refusal(*, detail: str, path: str, status: int) -> BillingError:
    if detail == '':
        message = 'a refusal carries the detail of its reply'
        raise ValueError(message)

    if not path.startswith('/'):
        message = f'path must start with a slash: {path!r}'
        raise ValueError(message)

    if STATUS_SUCCESS_FIRST <= status <= STATUS_SUCCESS_LAST:
        message = f'status {status} is a success, not a refusal'
        raise ValueError(message)

    if status == STATUS_TOO_MANY_REQUESTS:
        logger.warning('the AI service was busy for %s: %s', path, detail)

        message = 'The AI service is busy. Try again in a minute.'
        return GatewayBusyError(message)

    if status in STATUSES_REFUSED:
        logger.warning('the AI service refused %s with %s: %s', path, status, detail)

        message = f'The AI service could not handle this request ({status}).'
        return GatewayRefusedError(message)

    logger.error('the AI service answered %s for %s: %s', status, path, detail)

    return GatewayUnavailableError(UNAVAILABLE_MESSAGE)


def _piece_wait(pieces: queue.Queue[bytes]) -> bytes | None:
    if pieces.maxsize != PUMP_QUEUE_CAPACITY:
        message = f'the pump queue holds {PUMP_QUEUE_CAPACITY} pieces, not {pieces.maxsize}'
        raise ValueError(message)

    try:
        piece = pieces.get(timeout=GATEWAY_HEARTBEAT_SECONDS)
    except queue.Empty:
        return None
    else:
        return piece


def _pump_pieces(reply: http.client.HTTPResponse, pieces: queue.Queue[bytes]) -> None:
    if not STATUS_SUCCESS_FIRST <= reply.status <= STATUS_SUCCESS_LAST:
        message = f'the pump reads a successful reply, not one answered {reply.status}'
        raise ValueError(message)

    if pieces.maxsize != PUMP_QUEUE_CAPACITY:
        message = f'the pump queue holds {PUMP_QUEUE_CAPACITY} pieces, not {pieces.maxsize}'
        raise ValueError(message)

    received = 0

    for _ in range(GATEWAY_STREAM_PIECE_COUNT_MAX):
        piece = reply.read1(GATEWAY_STREAM_PIECE_BYTES)

        if piece == PUMP_END:
            return

        received += len(piece)

        if received > GATEWAY_REPLY_BYTES_MAX:
            logger.error('an AI reply ran past %s bytes and was cut', GATEWAY_REPLY_BYTES_MAX)
            return

        pieces.put(piece)

    logger.warning('an AI reply ran past %s pieces and was cut', GATEWAY_STREAM_PIECE_COUNT_MAX)


def _pump_run(reply: http.client.HTTPResponse, pieces: queue.Queue[bytes]) -> None:
    if not STATUS_SUCCESS_FIRST <= reply.status <= STATUS_SUCCESS_LAST:
        message = f'the pump reads a successful reply, not one answered {reply.status}'
        raise ValueError(message)

    if pieces.maxsize != PUMP_QUEUE_CAPACITY:
        message = f'the pump queue holds {PUMP_QUEUE_CAPACITY} pieces, not {pieces.maxsize}'
        raise ValueError(message)

    try:
        _pump_pieces(reply, pieces)
    except (OSError, ValueError, http.client.HTTPException):
        logger.exception('an AI reply stopped arriving')
    finally:
        pieces.put(PUMP_END)


def _pump_start(reply: http.client.HTTPResponse) -> queue.Queue[bytes]:
    if not STATUS_SUCCESS_FIRST <= reply.status <= STATUS_SUCCESS_LAST:
        message = f'the pump reads a successful reply, not one answered {reply.status}'
        raise ValueError(message)

    pieces = queue.Queue(maxsize=PUMP_QUEUE_CAPACITY)
    arguments = (reply, pieces)
    pump = threading.Thread(target=_pump_run, args=arguments, daemon=True, name='remi-ai-pump')

    pump.start()

    return pieces


def _reply_detail(reply: http.client.HTTPResponse) -> str:
    if STATUS_SUCCESS_FIRST <= reply.status <= STATUS_SUCCESS_LAST:
        message = f'only a refused reply carries a detail, not one answered {reply.status}'
        raise ValueError(message)

    try:
        detail = reply.read(GATEWAY_ERROR_DETAIL_BYTES)
    except (OSError, http.client.HTTPException):
        return 'the error body could not be read'
    else:
        return detail.decode(errors='replace').strip() or 'the error body is empty'


def _reply_relay(reply: http.client.HTTPResponse) -> HttpResponse:
    if not STATUS_SUCCESS_FIRST <= reply.status <= STATUS_SUCCESS_LAST:
        message = f'a relayed reply is a successful one, not one answered {reply.status}'
        raise ValueError(message)

    content_type = reply.headers.get('Content-Type', CONTENT_TYPE_JSON)
    status = reply.status

    with reply:
        body = reply.read(GATEWAY_REPLY_BYTES_MAX + 1)

    if len(body) > GATEWAY_REPLY_BYTES_MAX:
        logger.error('the AI service sent a reply over %s bytes', GATEWAY_REPLY_BYTES_MAX)
        raise GatewayUnavailableError(UNAVAILABLE_MESSAGE)

    return HttpResponse(body, content_type=content_type, status=status)


def _stream_pieces(reply: http.client.HTTPResponse) -> Iterator[bytes]:
    if not STATUS_SUCCESS_FIRST <= reply.status <= STATUS_SUCCESS_LAST:
        message = f'a streamed reply is a successful one, not one answered {reply.status}'
        raise ValueError(message)

    with reply:
        pieces = _pump_start(reply)

        yield STREAM_OPENING

        for _ in range(GATEWAY_STREAM_PIECE_COUNT_MAX):
            piece = _piece_wait(pieces)

            if piece is None:
                yield STREAM_HEARTBEAT
                continue

            if piece == PUMP_END:
                return

            yield piece


def _stream_relay(reply: http.client.HTTPResponse) -> StreamingHttpResponse:
    if not STATUS_SUCCESS_FIRST <= reply.status <= STATUS_SUCCESS_LAST:
        message = f'a streamed reply is a successful one, not one answered {reply.status}'
        raise ValueError(message)

    content_type = reply.headers.get('Content-Type', CONTENT_TYPE_EVENT_STREAM)
    pieces = _stream_pieces(reply)
    response = StreamingHttpResponse(pieces, content_type=content_type, status=reply.status)

    response['Cache-Control'] = 'no-cache'

    return response


def _whole_pieces(reply: http.client.HTTPResponse, *, assembled: bool) -> Iterator[bytes]:
    if not STATUS_SUCCESS_FIRST <= reply.status <= STATUS_SUCCESS_LAST:
        message = f'a whole reply is a successful one, not one answered {reply.status}'
        raise ValueError(message)

    body = bytearray()

    with reply:
        pieces = _pump_start(reply)

        yield WHOLE_HEARTBEAT

        for _ in range(GATEWAY_STREAM_PIECE_COUNT_MAX):
            piece = _piece_wait(pieces)

            if piece is None:
                yield WHOLE_HEARTBEAT
                continue

            if piece == PUMP_END:
                break

            body.extend(piece)

    reply_body = bytes(body)

    yield _completion_assemble(reply_body) if assembled else reply_body


def _whole_relay(reply: http.client.HTTPResponse) -> StreamingHttpResponse:
    if not STATUS_SUCCESS_FIRST <= reply.status <= STATUS_SUCCESS_LAST:
        message = f'a whole reply is a successful one, not one answered {reply.status}'
        raise ValueError(message)

    reply_type = reply.headers.get('Content-Type', CONTENT_TYPE_JSON)
    assembled = reply_type.startswith(CONTENT_TYPE_EVENT_STREAM)
    pieces = _whole_pieces(reply, assembled=assembled)
    response = StreamingHttpResponse(pieces, content_type=CONTENT_TYPE_JSON, status=reply.status)

    response['Cache-Control'] = 'no-cache'

    return response


def chat_relay(*, payload: dict[str, object]) -> StreamingHttpResponse:
    if payload.get('model') != MODEL_CHAT:
        message = f'a relayed chat names {MODEL_CHAT}: {payload.get("model")!r}'
        raise ValueError(message)

    streamed = payload.get('stream') is True
    options = {'include_usage': True}
    upstream = payload if streamed else {**payload, 'stream': True, 'stream_options': options}

    reply = _gateway_open(
        body=json.dumps(upstream).encode(),
        content_type=CONTENT_TYPE_JSON,
        key=settings.REMI_API_KEY_NOTES,
        path=PATH_CHAT,
    )

    if streamed:
        return _stream_relay(reply)

    return _whole_relay(reply)


def embeddings_relay(*, body: bytes) -> HttpResponse:
    if body == b'':
        message = 'a relayed embeddings request carries a body'
        raise ValueError(message)

    reply = _gateway_open(
        body=body,
        content_type=CONTENT_TYPE_JSON,
        key=settings.REMI_API_KEY_NOTES,
        path=PATH_EMBEDDINGS,
    )

    return _reply_relay(reply)


def multipart_encode(*, audio: bytes, fields: list[tuple[str, str]]) -> tuple[bytes, str]:
    if not audio.startswith(FLAC_MARKER):
        message = 'audio must be a FLAC stream'
        raise ValueError(message)

    if len(fields) > GATEWAY_FIELD_COUNT_MAX:
        message = f'The request carries more than {GATEWAY_FIELD_COUNT_MAX} fields.'
        raise RequestInvalidError(message)

    boundary = secrets.token_hex(BOUNDARY_BYTES)
    delimiter = f'--{boundary}\r\n'.encode()
    parts: list[bytes] = []

    for name, value in fields:
        if GATEWAY_FIELD_NAME_PATTERN.fullmatch(name) is None:
            message = f'The request carries a field remi does not forward: {name!r}'
            raise RequestInvalidError(message)

        encoded = value.encode()

        if len(encoded) > GATEWAY_FIELD_VALUE_BYTES_MAX:
            message = f'The {name} field runs over {GATEWAY_FIELD_VALUE_BYTES_MAX} bytes.'
            raise RequestInvalidError(message)

        disposition = f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()

        parts.append(delimiter + disposition + encoded + b'\r\n')

    file_header = (
        b'Content-Disposition: form-data; name="file"; filename="audio.flac"\r\n'
        b'Content-Type: audio/flac\r\n\r\n'
    )

    parts.append(delimiter + file_header + audio + b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())

    content_type = f'multipart/form-data; boundary={boundary}'
    return b''.join(parts), content_type


def transcription_relay(*, body: bytes, content_type: str) -> HttpResponse:
    if not content_type.startswith('multipart/form-data; boundary='):
        message = f'content_type must name a multipart boundary: {content_type!r}'
        raise ValueError(message)

    if not body.startswith(b'--'):
        message = 'body must open with a multipart delimiter'
        raise ValueError(message)

    reply = _gateway_open(
        body=body,
        content_type=content_type,
        key=settings.REMI_API_KEY_TRANSCRIPTION,
        path=PATH_TRANSCRIPTION,
    )

    return _reply_relay(reply)
