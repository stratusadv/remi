from __future__ import annotations

import hashlib
import json
import re
import threading
import time

from dataclasses import dataclass, field
from http import HTTPStatus
from socketserver import ThreadingMixIn
from typing_extensions import TYPE_CHECKING, Any
from urllib.parse import parse_qsl
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

from harness.stripe import stripe_signature_header
from harness.world.http import http_request
from harness.world.constants import (
    WORLD_GATEWAY_KEY_NOTES,
    WORLD_GATEWAY_KEY_TRANSCRIPTION,
    WORLD_PORT_MAX,
    WORLD_SENDGRID_API_KEY,
    WORLD_STRIPE_SECRET_KEY,
    WORLD_STRIPE_WEBHOOK_SECRET,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Sequence


BODY_BYTES_MAX = 64 << 20
GATEWAY_ANSWER = 'Morgan agreed to send the budget by Friday, and Riley will book the room.'
GATEWAY_AUTHORIZATIONS = frozenset({
    f'Bearer {WORLD_GATEWAY_KEY_NOTES}',
    f'Bearer {WORLD_GATEWAY_KEY_TRANSCRIPTION}',
})
GATEWAY_MODEL_IDS = ('stratus.embed', 'stratus.listen', 'stratus.thinking')
GATEWAY_STREAM_TOKENS = 1000
GATEWAY_TITLE = 'Weekly planning sync'
GATEWAY_TITLE_ASKED = 'short title'
GATEWAY_TRANSCRIPT_SENTENCES = (
    'Avery opened the planning meeting.',
    'Morgan agreed to send the budget by Friday.',
    'Riley will book the room for next week.',
)
GATEWAY_TRANSCRIPT = ' '.join(GATEWAY_TRANSCRIPT_SENTENCES)
GATEWAY_VECTOR_DIMENSIONS = 32
BRACKET_PATTERN = re.compile(r'\[([^\]]*)\]')
JSON_CONTENT = ('Content-Type', 'application/json')
SESSION_PATH_PATTERN = re.compile(r'/v1/checkout/sessions/(cs_[A-Za-z0-9_]+)')
STATUS_CODE_MAX = 599
STATUS_CODE_MIN = 100
WEBHOOK_TIMEOUT_SECONDS = 30


class ThreadingWSGIServer(ThreadingMixIn, WSGIServer):
    daemon_threads = True


class QuietHandler(WSGIRequestHandler):
    def log_request(self, *arguments: object, **keywords: object) -> None:
        _ = arguments
        _ = keywords


@dataclass
class FakesState:
    remi_url: str
    faults: dict[str, bool] = field(default_factory=dict)
    gateway_requests: list[dict[str, object]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)
    sendgrid_messages: list[dict[str, object]] = field(default_factory=list)
    sessions: dict[str, dict[str, object]] = field(default_factory=dict)
    webhooks: list[dict[str, object]] = field(default_factory=list)


def form_nested(pairs: Sequence[tuple[str, str]]) -> dict[str, Any]:
    if not isinstance(pairs, list | tuple):
        message = f'pairs must be a list or a tuple, not {type(pairs).__name__}'
        raise TypeError(message)

    nested: dict[str, Any] = {}

    for key, value in pairs:
        head = key.split('[', 1)[0]
        parts = [head, *BRACKET_PATTERN.findall(key)]
        target = nested

        for part in parts[:-1]:
            child = target.setdefault(part, {})

            if not isinstance(child, dict):
                message = f'the form key {key!r} nests under a value'
                raise TypeError(message)

            target = child

        target[parts[-1]] = value

    return nested


def _response(
    status: int,
    start_response: Callable[..., object],
    body: object = None,
    headers: list[tuple[str, str]] | None = None,
) -> Iterable[bytes]:
    if not STATUS_CODE_MIN <= status <= STATUS_CODE_MAX:
        message = f'status must be an HTTP status code: {status}'
        raise ValueError(message)

    if not isinstance(body, dict | list | None):
        message = f'body must be a JSON object, a JSON array, or None: {type(body).__name__}'
        raise TypeError(message)

    if not isinstance(headers, list | None):
        message = f'headers must be a list or None, not {type(headers).__name__}'
        raise TypeError(message)

    payload = b'' if body is None else json.dumps(body).encode()
    sent = [JSON_CONTENT, ('Content-Length', str(len(payload))), *(headers or [])]

    start_response(f'{status} {HTTPStatus(status).phrase}', sent)

    return [payload]


def _body_read(environ: dict[str, Any]) -> bytes:
    if 'wsgi.input' not in environ:
        message = 'environ must carry the wsgi.input stream'
        raise ValueError(message)

    length = int(environ.get('CONTENT_LENGTH') or '0')

    if not 0 <= length <= BODY_BYTES_MAX:
        message = f'a request body of {length} bytes is outside what the fakes read'
        raise ValueError(message)

    return environ['wsgi.input'].read(length)


class Fakes:
    def __init__(self, state: FakesState) -> None:
        if not isinstance(state, FakesState):
            message = f'state must be a FakesState, not {type(state).__name__}'
            raise TypeError(message)

        self.state = state

    def __call__(
        self,
        environ: dict[str, Any],
        start_response: Callable[..., object],
    ) -> Iterable[bytes]:
        if 'REQUEST_METHOD' not in environ:
            message = 'environ must carry the REQUEST_METHOD'
            raise ValueError(message)

        method = environ['REQUEST_METHOD']
        path = environ.get('PATH_INFO', '')
        body = _body_read(environ)

        if path.startswith('/control/'):
            return self._control(method=method, path=path, body=body, start_response=start_response)

        if path.startswith('/v1/checkout/sessions'):
            return self._stripe(
                environ=environ,
                method=method,
                path=path,
                body=body,
                start_response=start_response,
            )

        if path == '/v3/mail/send':
            return self._sendgrid(environ, body, start_response)

        return self._gateway(
            environ=environ,
            method=method,
            path=path,
            body=body,
            start_response=start_response,
        )

    def _control(
        self,
        *,
        method: str,
        path: str,
        body: bytes,
        start_response: Callable[..., object],
    ) -> Iterable[bytes]:
        if not isinstance(method, str):
            message = f'method must be a str, not {type(method).__name__}'
            raise TypeError(message)

        if not path.startswith('/control/'):
            message = f'path must be a control path: {path!r}'
            raise ValueError(message)

        if not isinstance(body, bytes):
            message = f'body must be bytes, not {type(body).__name__}'
            raise TypeError(message)

        if path == '/control/state':
            if method == 'GET':
                with self.state.lock:
                    snapshot = {
                        'gateway_requests': list(self.state.gateway_requests),
                        'sendgrid_messages': list(self.state.sendgrid_messages),
                        'sessions': list(self.state.sessions.values()),
                        'webhooks': list(self.state.webhooks),
                    }

                return _response(200, start_response, snapshot)

        payload = json.loads(body or b'{}')

        if path == '/control/stripe/pay':
            if method == 'POST':
                webhook = payload.get('webhook', True)
                delivered = self.session_pay(payload['session_id'], webhook=webhook)

                return _response(200, start_response, {'webhook_status': delivered})

        if path == '/control/stripe/webhook':
            if method == 'POST':
                with self.state.lock:
                    session = dict(self.state.sessions[payload['session_id']])

                status = self.webhook_deliver(payload['type'], session)
                return _response(200, start_response, {'webhook_status': status})

        if path == '/control/faults':
            if method == 'POST':
                with self.state.lock:
                    self.state.faults.update({key: bool(value) for key, value in payload.items()})

                return _response(200, start_response, dict(self.state.faults))

        if path == '/control/reset':
            if method == 'POST':
                self.reset()

                cleared = {}
                return _response(200, start_response, cleared)

        return _response(404, start_response, {'error': f'no control {method} {path}'})

    def reset(self) -> None:
        with self.state.lock:
            self.state.faults.clear()
            self.state.gateway_requests.clear()
            self.state.sendgrid_messages.clear()
            self.state.sessions.clear()
            self.state.webhooks.clear()

    def _stripe(
        self,
        *,
        environ: dict[str, Any],
        method: str,
        path: str,
        body: bytes,
        start_response: Callable[..., object],
    ) -> Iterable[bytes]:
        if not isinstance(environ, dict):
            message = f'environ must be a dict, not {type(environ).__name__}'
            raise TypeError(message)

        if not isinstance(method, str):
            message = f'method must be a str, not {type(method).__name__}'
            raise TypeError(message)

        if not path.startswith('/v1/checkout/sessions'):
            message = f'path must be a checkout session path: {path!r}'
            raise ValueError(message)

        if not isinstance(body, bytes):
            message = f'body must be bytes, not {type(body).__name__}'
            raise TypeError(message)

        if environ.get('HTTP_AUTHORIZATION') != f'Bearer {WORLD_STRIPE_SECRET_KEY}':
            refusal = {'message': 'Invalid API Key provided', 'type': 'invalid_request_error'}
            return _response(401, start_response, {'error': refusal})

        if self.state.faults.get('stripe_down'):
            error = {'error': {'message': 'Stripe is down in the world', 'type': 'api_error'}}
            return _response(503, start_response, error)

        if path == '/v1/checkout/sessions':
            if method == 'POST':
                parameters = form_nested(parse_qsl(body.decode(), keep_blank_values=True))
                session = self._session_create(parameters)

                return _response(200, start_response, session)

        matched = SESSION_PATH_PATTERN.fullmatch(path)

        if matched is not None:
            if method == 'GET':
                return self._session_read(matched[1], start_response)

        return _response(404, start_response, {'error': {'message': f'no Stripe route {path}'}})

    def _session_create(self, parameters: dict[str, Any]) -> dict[str, object]:
        if 'line_items' not in parameters:
            message = f'a checkout session needs line_items: {sorted(parameters)}'
            raise ValueError(message)

        with self.state.lock:
            line_item = parameters['line_items']['0']
            price = line_item['price_data']
            amount_total = int(price['unit_amount']) * int(line_item['quantity'])
            session_id = f'cs_test_world{len(self.state.sessions) + 1}'

            session = {
                'amount_total': amount_total,
                'client_reference_id': parameters.get('client_reference_id'),
                'client_secret': f'{session_id}_secret_world',
                'currency': price['currency'],
                'customer_email': parameters.get('customer_email'),
                'id': session_id,
                'metadata': parameters.get('metadata', {}),
                'mode': parameters.get('mode'),
                'object': 'checkout.session',
                'payment_intent': None,
                'payment_status': 'unpaid',
                'return_url': parameters.get('return_url'),
                'status': 'open',
                'ui_mode': parameters.get('ui_mode'),
            }

            self.state.sessions[session_id] = session

        return session

    def _session_read(
        self,
        session_id: str,
        start_response: Callable[..., object],
    ) -> Iterable[bytes]:
        if not session_id.startswith('cs_'):
            message = f'session_id must name a checkout session: {session_id!r}'
            raise ValueError(message)

        with self.state.lock:
            session = self.state.sessions.get(session_id)

        if session is None:
            message = f'No such checkout.session: {session_id!r}'

            error = {
                'code': 'resource_missing',
                'message': message,
                'param': 'session',
                'type': 'invalid_request_error',
            }

            return _response(404, start_response, {'error': error})

        return _response(200, start_response, session)

    def session_pay(self, session_id: str, *, webhook: bool) -> int | None:
        if not isinstance(session_id, str):
            message = f'session_id must be a str, not {type(session_id).__name__}'
            raise TypeError(message)

        with self.state.lock:
            session = self.state.sessions[session_id]
            session['payment_intent'] = session_id.replace('cs_', 'pi_', 1)
            session['payment_status'] = 'paid'
            session['status'] = 'complete'
            event_session = dict(session)

        if not webhook:
            return None

        return self.webhook_deliver('checkout.session.completed', event_session)

    def webhook_deliver(self, event_type: str, session: dict[str, object]) -> int:
        if not isinstance(event_type, str):
            message = f'event_type must be a str, not {type(event_type).__name__}'
            raise TypeError(message)

        if not isinstance(session, dict):
            message = f'session must be a dict, not {type(session).__name__}'
            raise TypeError(message)

        event = {
            'data': {'object': session},
            'id': f'evt_world_{int(time.time() * 1000)}',
            'object': 'event',
            'type': event_type,
        }

        payload = json.dumps(event)
        timestamp = int(time.time())
        secret = WORLD_STRIPE_WEBHOOK_SECRET
        header = stripe_signature_header(payload, secret=secret, timestamp=timestamp)
        headers = {'Content-Type': 'application/json', 'Stripe-Signature': header}

        reply = http_request(
            f'{self.state.remi_url}/api/stripe/event/',
            body=payload.encode(),
            headers=headers,
            method='POST',
            timeout=WEBHOOK_TIMEOUT_SECONDS,
        )

        with self.state.lock:
            delivery = {'session_id': session['id'], 'status': reply.status, 'type': event_type}

            self.state.webhooks.append(delivery)

        return reply.status

    def _sendgrid(
        self,
        environ: dict[str, Any],
        body: bytes,
        start_response: Callable[..., object],
    ) -> Iterable[bytes]:
        if not isinstance(environ, dict):
            message = f'environ must be a dict, not {type(environ).__name__}'
            raise TypeError(message)

        if not isinstance(body, bytes):
            message = f'body must be bytes, not {type(body).__name__}'
            raise TypeError(message)

        if environ.get('HTTP_AUTHORIZATION') != f'Bearer {WORLD_SENDGRID_API_KEY}':
            return _response(401, start_response, {'errors': [{'message': 'bad key'}]})

        if self.state.faults.get('sendgrid_down'):
            return _response(503, start_response, {'errors': [{'message': 'SendGrid is down'}]})

        with self.state.lock:
            payload = json.loads(body)
            content = {part['type']: part['value'] for part in payload['content']}

            sendgrid_message = {
                'html': content.get('text/html', ''),
                'subject': payload['subject'],
                'text': content.get('text/plain', ''),
                'to': [recipient['email'] for recipient in payload['personalizations'][0]['to']],
            }

            self.state.sendgrid_messages.append(sendgrid_message)
            headers = [('X-Message-Id', f'world-{len(self.state.sendgrid_messages)}')]

        return _response(202, start_response, None, headers)

    def _gateway(
        self,
        *,
        environ: dict[str, Any],
        method: str,
        path: str,
        body: bytes,
        start_response: Callable[..., object],
    ) -> Iterable[bytes]:
        if not isinstance(environ, dict):
            message = f'environ must be a dict, not {type(environ).__name__}'
            raise TypeError(message)

        if not isinstance(method, str):
            message = f'method must be a str, not {type(method).__name__}'
            raise TypeError(message)

        if not isinstance(path, str):
            message = f'path must be a str, not {type(path).__name__}'
            raise TypeError(message)

        if not isinstance(body, bytes):
            message = f'body must be bytes, not {type(body).__name__}'
            raise TypeError(message)

        authorization = environ.get('HTTP_AUTHORIZATION', '')

        with self.state.lock:
            request = {'authorization': authorization, 'method': method, 'path': path}

            self.state.gateway_requests.append(request)

        if authorization not in GATEWAY_AUTHORIZATIONS:
            refusal = {'message': 'The gateway key is not valid.', 'type': 'invalid_request_error'}
            return _response(401, start_response, {'error': refusal})

        if self.state.faults.get('gateway_down'):
            return _response(503, start_response, {'error': {'message': 'The gateway is down.'}})

        return gateway_route(method=method, path=path, body=body, start_response=start_response)


def gateway_route(
    *,
    method: str,
    path: str,
    body: bytes,
    start_response: Callable[..., object],
) -> Iterable[bytes]:
    if not isinstance(method, str):
        message = f'method must be a str, not {type(method).__name__}'
        raise TypeError(message)

    if not isinstance(path, str):
        message = f'path must be a str, not {type(path).__name__}'
        raise TypeError(message)

    if not isinstance(body, bytes):
        message = f'body must be bytes, not {type(body).__name__}'
        raise TypeError(message)

    if path == '/v1/models':
        models = [{'id': model_id, 'object': 'model'} for model_id in GATEWAY_MODEL_IDS]
        return _response(200, start_response, {'data': models, 'object': 'list'})

    if method == 'POST':
        if path == '/v1/audio/transcriptions':
            return _response(200, start_response, gateway_transcript(body))

        if path == '/v1/embeddings':
            return _response(200, start_response, gateway_embeddings(json.loads(body)))

        if path == '/v1/chat/completions':
            return gateway_chat(json.loads(body), start_response)

    missing = {'message': f'no fake route {method} {path}'}
    return _response(404, start_response, {'error': missing})


def gateway_chat(payload: dict[str, Any], start_response: Callable[..., object]) -> Iterable[bytes]:
    if not isinstance(payload, dict):
        message = f'payload must be a JSON object, not {type(payload).__name__}'
        raise TypeError(message)

    response_format = payload.get('response_format') or {}
    schema_name = response_format.get('json_schema', {}).get('name', '')

    if schema_name == 'meeting_search':
        question = gateway_question(payload)
        content = json.dumps({'names': [], 'queries': ['budget'], 'question': question})
        reply = gateway_reply(content)

        return _response(200, start_response, reply)

    system = str(payload['messages'][0]['content']) if payload.get('messages') else ''
    content = GATEWAY_TITLE if GATEWAY_TITLE_ASKED in system.lower() else GATEWAY_ANSWER

    if payload.get('stream'):
        return gateway_chat_stream(content, start_response)

    return _response(200, start_response, gateway_reply(content))


def gateway_chat_stream(content: str, start_response: Callable[..., object]) -> Iterable[bytes]:
    if not isinstance(content, str):
        message = f'content must be a str, not {type(content).__name__}'
        raise TypeError(message)

    words = content.split(' ')
    pieces = [f'{word} ' for word in words[:-1]] + words[-1:]

    events = [
        {'choices': [{'delta': {'content': piece}, 'index': 0}]}
        for piece in pieces
    ]

    totals = {'completion_tokens': 40, 'prompt_tokens': 960, 'total_tokens': GATEWAY_STREAM_TOKENS}
    usage = {'choices': [], 'usage': totals}
    lines = [f'data: {json.dumps(event)}\n\n' for event in [*events, usage]]
    stream = ''.join([*lines, 'data: [DONE]\n\n']).encode()
    headers = [('Content-Type', 'text/event-stream'), ('Content-Length', str(len(stream)))]

    start_response('200 OK', headers)

    return [stream]


def gateway_embeddings(payload: dict[str, Any]) -> dict[str, object]:
    if 'input' not in payload:
        message = 'an embeddings request must carry an input'
        raise ValueError(message)

    inputs = payload['input'] if isinstance(payload['input'], list) else [payload['input']]

    data = [
        {'embedding': gateway_vector(str(text)), 'index': index, 'object': 'embedding'}
        for index, text in enumerate(inputs)
    ]

    return {'data': data, 'model': payload.get('model', ''), 'object': 'list'}


def gateway_question(payload: dict[str, Any]) -> str:
    if not isinstance(payload, dict):
        message = f'payload must be a JSON object, not {type(payload).__name__}'
        raise TypeError(message)

    messages = payload.get('messages', [])
    user = str(messages[-1]['content']) if messages else ''
    lines = [line.strip() for line in user.splitlines() if line.strip() != '']

    return lines[-1] if lines else 'What did the meeting decide?'


def gateway_reply(content: str) -> dict[str, object]:
    if not isinstance(content, str):
        error = f'content must be a str, not {type(content).__name__}'
        raise TypeError(error)

    message = {'content': content, 'role': 'assistant'}
    usage = {'completion_tokens': 20, 'prompt_tokens': 180, 'total_tokens': 200}

    choices = [{'index': 0, 'message': message}]
    return {'choices': choices, 'object': 'chat.completion', 'usage': usage}


def gateway_transcript(body: bytes) -> dict[str, object]:
    if not isinstance(body, bytes):
        message = f'body must be bytes, not {type(body).__name__}'
        raise TypeError(message)

    verbose = b'verbose_json' in body

    if not verbose:
        return {'text': GATEWAY_TRANSCRIPT}

    segments = [
        {'end': float(index * 4 + 4), 'start': float(index * 4), 'text': sentence}
        for index, sentence in enumerate(GATEWAY_TRANSCRIPT_SENTENCES)
    ]

    return {'segments': segments, 'text': GATEWAY_TRANSCRIPT}


def gateway_vector(text: str) -> list[float]:
    if not isinstance(text, str):
        message = f'text must be a str, not {type(text).__name__}'
        raise TypeError(message)

    vector = [0.0] * GATEWAY_VECTOR_DIMENSIONS

    for word in text.lower().split():
        digest = hashlib.sha256(word.encode()).digest()
        vector[digest[0] % GATEWAY_VECTOR_DIMENSIONS] += 1.0

    norm = sum(value * value for value in vector) ** 0.5 or 1.0
    return [value / norm for value in vector]


@dataclass
class FakesServer:
    fakes: Fakes
    server: ThreadingWSGIServer
    thread: threading.Thread

    @property
    def url(self) -> str:
        host, port = self.server.server_address[:2]
        return f'http://{host}:{port}'

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=10)


def fakes_start(*, port: int, remi_url: str) -> FakesServer:
    if not 0 <= port <= WORLD_PORT_MAX:
        message = f'port must be from 0 to {WORLD_PORT_MAX}: {port}'
        raise ValueError(message)

    if not remi_url.startswith('http://'):
        message = f'remi_url must be a plain http url: {remi_url!r}'
        raise ValueError(message)

    state = FakesState(remi_url=remi_url)
    fakes = Fakes(state)

    server = make_server(
        '127.0.0.1',
        port,
        fakes,
        server_class=ThreadingWSGIServer,
        handler_class=QuietHandler,
    )

    thread = threading.Thread(target=server.serve_forever, daemon=True, name='remi-world-fakes')
    thread.start()

    return FakesServer(fakes=fakes, server=server, thread=thread)
