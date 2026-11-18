from __future__ import annotations

import json
import logging
import threading
import time

import pytest

from dataclasses import dataclass, field
from datetime import timedelta
from typing_extensions import TYPE_CHECKING, Any
from wsgiref.simple_server import make_server

from django.core.files.uploadedfile import SimpleUploadedFile
from django.http import StreamingHttpResponse
from django.utils import timezone

from app.account.constants import SECONDS_PER_HOUR
from app.account.ledger.models import AccountLedgerEntry
from app.account.tests.factories import create_test_account
from app.account.transcription.models import AccountTranscriptionChunk
from app.api.v1.ai import router as ai_router
from app.core.exceptions import GatewayBusyError, GatewayRefusedError, GatewayUnavailableError
from app.gateway import client as gateway_client
from app.gateway.constants import (
    GATEWAY_AUDIO_BYTES_MAX,
    MODEL_CHAT,
    MODEL_EMBEDDINGS,
    MODEL_TRANSCRIPTION,
)
from app.gateway.tests.factories import FLAC_SAMPLE_RATE, create_test_flac
from harness.api import (
    AI_CHAT_PATH,
    AI_EMBEDDINGS_PATH,
    AI_MODELS_PATH,
    AI_TRANSCRIPTION_PATH,
    api_post,
)
from harness.world.constants import WORLD_GATEWAY_KEY_NOTES, WORLD_GATEWAY_KEY_TRANSCRIPTION
from harness.world.fakes import (
    GATEWAY_STREAM_TOKENS,
    GATEWAY_TITLE,
    GATEWAY_TRANSCRIPT,
    QuietHandler,
    ThreadingWSGIServer,
    fakes_start,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Generator, Iterator, Mapping

    from django.test import Client
    from django.test.client import _MonkeyPatchedWSGIResponse

    from pytest_django.fixtures import Settings

    from app.account.models import Account
    from harness.world.fakes import FakesServer


pytestmark = pytest.mark.django_db
HEARTBEAT_SECONDS = 0.05
JOB_ID = '86dfb1d3b0140ecf2fd59075421f1cb5'
JOB_ID_OTHER = '47ead100cc5cd956aa10b3c4d5e6f708'
SECONDS_CHARGED = 60
SLOW_PAUSE_SECONDS = 0.4
SLOW_TOKENS = 42
WINDOW_DAYS = 30

SLOW_EVENTS_FIRST = (
    b'data: {"choices": [{"delta": {"reasoning_content": "thinking"}, "index": 0}]}\n\n'
    b'data: {"choices": [{"delta": {"content": "Budget "}, "index": 0}]}\n\n'
)

SLOW_EVENTS_LAST = (
    b'data: {"choices": [{"delta": {"content": "review"}, "index": 0}]}\n\n'
    b'data: {"choices": [], "usage": {"total_tokens": 42}}\n\n'
    b'data: [DONE]\n\n'
)

SLOW_EVENTS_FAILING = b'data: {"error": {"message": "The model is overloaded."}}\n\n'


@dataclass
class _SlowGateway:
    bodies: list[bytes] = field(default_factory=list)
    events_last: bytes = SLOW_EVENTS_LAST

    def __call__(
        self,
        environ: dict[str, Any],
        start_response: Callable[..., object],
    ) -> Iterator[bytes]:
        assert 'wsgi.input' in environ

        length = int(environ.get('CONTENT_LENGTH') or '0')

        assert 0 < length < 1 << 20

        self.bodies.append(environ['wsgi.input'].read(length))

        headers = [('Content-Type', 'text/event-stream')]

        start_response('200 OK', headers)

        return self._events()

    def _events(self) -> Iterator[bytes]:
        yield SLOW_EVENTS_FIRST

        time.sleep(SLOW_PAUSE_SECONDS)

        yield self.events_last


@pytest.fixture
def slow_gateway(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
) -> Generator[_SlowGateway]:
    slow = _SlowGateway()

    server = make_server(
        '127.0.0.1',
        0,
        slow,
        server_class=ThreadingWSGIServer,
        handler_class=QuietHandler,
    )

    thread = threading.Thread(target=server.serve_forever, daemon=True, name='remi-slow-ai')
    host, port = server.server_address[:2]

    monkeypatch.setattr(gateway_client, 'GATEWAY_HEARTBEAT_SECONDS', HEARTBEAT_SECONDS)

    settings.REMI_API_HOST = f'http://{host!s}:{port}'
    settings.REMI_API_KEY_NOTES = 'slow-key'
    settings.REMI_ASK_WINDOW_DAYS = WINDOW_DAYS

    thread.start()

    try:
        yield slow
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=10)


@pytest.fixture
def gateway(settings: Settings) -> Generator[FakesServer]:
    server = fakes_start(port=0, remi_url='http://127.0.0.1:9')

    settings.REMI_API_HOST = server.url
    settings.REMI_API_KEY_NOTES = WORLD_GATEWAY_KEY_NOTES
    settings.REMI_API_KEY_TRANSCRIPTION = WORLD_GATEWAY_KEY_TRANSCRIPTION
    settings.REMI_ASK_WINDOW_DAYS = WINDOW_DAYS

    try:
        yield server
    finally:
        server.stop()


def _account_ready(*, email: str = 'avery@example.com', seconds: int) -> tuple[Account, str]:
    assert '@' in email
    assert seconds >= SECONDS_CHARGED

    account = create_test_account(email=email, seconds=seconds)

    account.services.processor.charge(job_id=JOB_ID, seconds=SECONDS_CHARGED)

    token = account.services.processor.token_issue()

    return account, token


def _authorizations(gateway: FakesServer) -> list[object]:
    with gateway.fakes.state.lock:
        return [request['authorization'] for request in gateway.fakes.state.gateway_requests]


def _body(response: _MonkeyPatchedWSGIResponse) -> bytes:
    assert isinstance(response, StreamingHttpResponse)

    return response.getvalue()


def _chat(
    client: Client,
    token: str,
    *,
    fields: Mapping[str, object] | None = None,
    model: str = MODEL_CHAT,
    stream: bool = False,
) -> _MonkeyPatchedWSGIResponse:
    assert token
    assert model

    messages = [
        {'content': 'Write a short title for this meeting.', 'role': 'system'},
        {'content': 'Morgan will send the budget by Friday.', 'role': 'user'},
    ]

    body = {'messages': messages, 'model': model, 'stream': stream, **(fields or {})}
    return api_post(client, AI_CHAT_PATH, body=body, token=token)


def _error_code(response: _MonkeyPatchedWSGIResponse) -> str:
    assert response.status_code >= 400

    return response.json()['error']['code']


def _transcribe(
    client: Client,
    token: str,
    *,
    audio: bytes,
    job_id: str = JOB_ID,
    model: str = MODEL_TRANSCRIPTION,
) -> _MonkeyPatchedWSGIResponse:
    assert token
    assert len(audio) <= GATEWAY_AUDIO_BYTES_MAX
    assert len(job_id) in (0, len(JOB_ID))
    assert model

    upload = SimpleUploadedFile('chunk.flac', audio, content_type='audio/flac')
    headers = {'Authorization': f'Bearer {token}', 'Remi-Job-Id': job_id}
    data = {'file': upload, 'model': model}

    return client.post(AI_TRANSCRIPTION_PATH, data=data, headers=headers)


def _seconds_of_audio(seconds: int, *, salt: int = 0) -> bytes:
    assert seconds > 0
    assert salt >= 0

    return create_test_flac(body=bytes([salt]), sample_count=seconds * FLAC_SAMPLE_RATE)


def test_the_model_list_names_only_the_model_remi_writes_with(
    client: Client,
    gateway: FakesServer,
) -> None:
    _, token = _account_ready(seconds=SECONDS_PER_HOUR)

    listed = client.get(AI_MODELS_PATH, headers={'Authorization': f'Bearer {token}'})
    anonymous = client.get(AI_MODELS_PATH)

    assert listed.status_code == 200
    assert [model['id'] for model in listed.json()['data']] == [MODEL_CHAT]
    assert anonymous.status_code == 401
    assert _authorizations(gateway) == []


def test_a_chat_reaches_the_ai_service_with_the_server_key_and_never_the_token(
    client: Client,
    gateway: FakesServer,
) -> None:
    _, token = _account_ready(seconds=SECONDS_PER_HOUR)

    response = _chat(client, token)
    authorizations = _authorizations(gateway)
    completion = json.loads(_body(response))

    assert response.status_code == 200
    assert completion['choices'][0]['message']['content'] == GATEWAY_TITLE
    assert completion['usage']['total_tokens'] == GATEWAY_STREAM_TOKENS
    assert authorizations == [f'Bearer {WORLD_GATEWAY_KEY_NOTES}']
    assert all(token not in str(authorization) for authorization in authorizations)


def test_a_streamed_chat_arrives_as_the_ai_service_sent_it(
    client: Client,
    gateway: FakesServer,
) -> None:
    _, token = _account_ready(seconds=SECONDS_PER_HOUR)

    response = _chat(client, token, stream=True)
    streamed = _body(response).decode()
    events = [line for line in streamed.split('\n\n') if line.startswith('data: {')]
    pieces = [json.loads(event.removeprefix('data: ')) for event in events]
    text = ''.join(piece['choices'][0]['delta']['content'] for piece in pieces if piece['choices'])

    assert response.status_code == 200
    assert response['Content-Type'].startswith('text/event-stream')
    assert streamed.startswith(':')
    assert streamed.endswith('data: [DONE]\n\n')
    assert text.strip() != ''
    assert len(_authorizations(gateway)) == 1


def test_a_streamed_reply_carries_keep_alive_comments_through_a_silent_stretch(
    client: Client,
    slow_gateway: _SlowGateway,
) -> None:
    _, token = _account_ready(seconds=SECONDS_PER_HOUR)

    streamed = _body(_chat(client, token, stream=True))
    events = [line for line in streamed.split(b'\n') if line.startswith(b'data: {')]
    choices = [json.loads(event.removeprefix(b'data: '))['choices'] for event in events]
    text = ''.join(choice[0]['delta'].get('content', '') for choice in choices if choice)

    assert streamed.startswith(b': ')
    assert streamed.count(b': keep-alive') >= 2
    assert text == 'Budget review'
    assert len(slow_gateway.bodies) == 1


def test_a_whole_reply_sends_whitespace_through_a_silent_stretch_then_assembled_json(
    client: Client,
    slow_gateway: _SlowGateway,
) -> None:
    assert slow_gateway.bodies == []

    _, token = _account_ready(seconds=SECONDS_PER_HOUR)

    body = _body(_chat(client, token))
    leading = len(body) - len(body.lstrip())
    completion = json.loads(body)
    sent = json.loads(slow_gateway.bodies[0])

    assert leading >= 3
    assert completion['choices'][0]['message']['content'] == 'Budget review'
    assert completion['usage'] == {'total_tokens': SLOW_TOKENS}
    assert sent['stream'] is True
    assert sent['stream_options'] == {'include_usage': True}


def test_a_whole_reply_whose_stream_fails_comes_back_as_an_error_envelope(
    client: Client,
    monkeypatch: pytest.MonkeyPatch,
    slow_gateway: _SlowGateway,
) -> None:
    assert slow_gateway.events_last == SLOW_EVENTS_LAST

    _, token = _account_ready(seconds=SECONDS_PER_HOUR)

    monkeypatch.setattr(slow_gateway, 'events_last', SLOW_EVENTS_FAILING)

    failure = json.loads(_body(_chat(client, token)))

    assert failure == {'error': {'message': 'The model is overloaded.'}}


def test_a_chat_needs_hours_left_on_the_account(client: Client, gateway: FakesServer) -> None:
    _, token = _account_ready(seconds=SECONDS_CHARGED)

    response = _chat(client, token)

    assert response.status_code == 402
    assert _error_code(response) == 'balance_insufficient'
    assert _authorizations(gateway) == []


def test_a_chat_needs_a_recording_processed_within_the_window(
    client: Client,
    gateway: FakesServer,
) -> None:
    account, token = _account_ready(seconds=SECONDS_PER_HOUR)
    aged = timezone.now() - timedelta(days=WINDOW_DAYS + 1)

    AccountLedgerEntry.objects.filter(account=account).update(created_datetime=aged)

    response = _chat(client, token)

    assert response.status_code == 403
    assert _error_code(response) == 'gateway_inactive'
    assert _authorizations(gateway) == []


def test_a_chat_for_another_model_is_refused(client: Client, gateway: FakesServer) -> None:
    _, token = _account_ready(seconds=SECONDS_PER_HOUR)

    response = _chat(client, token, model='gpt-expensive')

    assert response.status_code == 400
    assert _error_code(response) == 'request_invalid'
    assert _authorizations(gateway) == []


@pytest.mark.parametrize('effort', ['medium', 'xhigh', 'LOW', ''])
def test_a_chat_asking_for_more_thinking_than_low_is_refused(
    client: Client,
    effort: str,
    gateway: FakesServer,
) -> None:
    _, token = _account_ready(seconds=SECONDS_PER_HOUR)
    fields = {'reasoning_effort': effort}

    response = _chat(client, token, fields=fields)

    assert response.status_code == 400
    assert _error_code(response) == 'request_invalid'
    assert _authorizations(gateway) == []


def test_the_gateway_decides_whether_the_model_thinks(
    client: Client,
    slow_gateway: _SlowGateway,
) -> None:
    _, token = _account_ready(seconds=SECONDS_PER_HOUR)
    asked = {'chat_template_kwargs': {'enable_thinking': True}}
    low = {'chat_template_kwargs': {'enable_thinking': False}, 'reasoning_effort': 'low'}

    _body(_chat(client, token, fields=asked))
    _body(_chat(client, token, fields=low))

    sent_asked, sent_low = (json.loads(body) for body in slow_gateway.bodies)

    assert sent_asked['chat_template_kwargs'] == {'enable_thinking': False}
    assert 'reasoning_effort' not in sent_asked
    assert sent_low['chat_template_kwargs'] == {'enable_thinking': True}
    assert sent_low['reasoning_effort'] == 'low'


def test_embeddings_reach_the_ai_service_with_the_notes_key(
    client: Client,
    gateway: FakesServer,
) -> None:
    _, token = _account_ready(seconds=SECONDS_PER_HOUR)
    body = {'input': ['budget friday', 'room booking'], 'model': MODEL_EMBEDDINGS}

    response = api_post(client, AI_EMBEDDINGS_PATH, body=body, token=token)

    assert response.status_code == 200
    assert len(response.json()['data']) == 2
    assert _authorizations(gateway) == [f'Bearer {WORLD_GATEWAY_KEY_NOTES}']


def test_a_charged_recording_is_transcribed_with_the_transcription_key(
    client: Client,
    gateway: FakesServer,
) -> None:
    account, token = _account_ready(seconds=SECONDS_PER_HOUR)

    response = _transcribe(client, token, audio=_seconds_of_audio(30))

    assert response.status_code == 200
    assert response.json() == {'text': GATEWAY_TRANSCRIPT}
    assert _authorizations(gateway) == [f'Bearer {WORLD_GATEWAY_KEY_TRANSCRIPTION}']
    assert account.transcription_chunks.milliseconds_total() == 30_000


def test_transcription_stops_at_the_length_the_recording_was_charged_for(
    client: Client,
    gateway: FakesServer,
) -> None:
    account, token = _account_ready(seconds=SECONDS_PER_HOUR)

    statuses = [
        _transcribe(client, token, audio=_seconds_of_audio(30, salt=1)).status_code,
        _transcribe(client, token, audio=_seconds_of_audio(30, salt=2)).status_code,
        _transcribe(client, token, audio=_seconds_of_audio(30, salt=1)).status_code,
        _transcribe(client, token, audio=_seconds_of_audio(2, salt=3)).status_code,
    ]

    refused = _transcribe(client, token, audio=_seconds_of_audio(1, salt=4))

    assert statuses == [200, 200, 200, 200]
    assert refused.status_code == 403
    assert _error_code(refused) == 'transcription_unpaid'
    assert len(_authorizations(gateway)) == 4
    assert account.transcription_chunks.milliseconds_total() == 62_000


def test_a_recording_never_charged_is_refused_before_the_ai_service(
    client: Client,
    gateway: FakesServer,
) -> None:
    _, token = _account_ready(seconds=SECONDS_PER_HOUR)

    response = _transcribe(client, token, audio=_seconds_of_audio(5), job_id=JOB_ID_OTHER)
    missing = _transcribe(client, token, audio=_seconds_of_audio(5), job_id='')

    assert response.status_code == 403
    assert _error_code(response) == 'transcription_unpaid'
    assert missing.status_code == 400
    assert _authorizations(gateway) == []
    assert AccountTranscriptionChunk.objects.count() == 0


@pytest.mark.parametrize(
    ('audio', 'model'),
    [
        (b'RIFF' + bytes(60), MODEL_TRANSCRIPTION),
        (create_test_flac(sample_count=FLAC_SAMPLE_RATE, channels=2), MODEL_TRANSCRIPTION),
        (create_test_flac(sample_count=FLAC_SAMPLE_RATE), 'whisper-large'),
    ],
)
def test_audio_or_a_model_remi_does_not_send_is_refused(
    audio: bytes,
    client: Client,
    gateway: FakesServer,
    model: str,
) -> None:
    assert len(audio) <= GATEWAY_AUDIO_BYTES_MAX
    assert model

    _, token = _account_ready(seconds=SECONDS_PER_HOUR)

    response = _transcribe(client, token, audio=audio, model=model)

    assert response.status_code == 400
    assert _authorizations(gateway) == []
    assert AccountTranscriptionChunk.objects.count() == 0


def test_an_ai_service_that_is_down_or_unreachable_answers_unavailable(
    client: Client,
    gateway: FakesServer,
    settings: Settings,
) -> None:
    _, token = _account_ready(seconds=SECONDS_PER_HOUR)

    gateway.fakes.state.faults['gateway_down'] = True

    down = _chat(client, token)

    settings.REMI_API_HOST = 'http://127.0.0.1:9'

    unreachable = _chat(client, token)

    settings.REMI_API_HOST = ''

    unset = _chat(client, token)

    for response in (down, unreachable, unset):
        assert response.status_code == 503
        assert _error_code(response) == 'gateway_unavailable'


def test_a_server_key_the_ai_service_refuses_never_reads_as_signed_out(
    client: Client,
    gateway: FakesServer,
    settings: Settings,
) -> None:
    _, token = _account_ready(seconds=SECONDS_PER_HOUR)

    settings.REMI_API_KEY_NOTES = 'wrong-key'

    response = _chat(client, token)

    assert response.status_code == 503
    assert _error_code(response) == 'gateway_unavailable'
    assert _authorizations(gateway) == ['Bearer wrong-key']


def test_chat_past_the_minute_limit_is_throttled_for_that_account_alone(
    client: Client,
    gateway: FakesServer,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, token = _account_ready(seconds=SECONDS_PER_HOUR)
    _, token_other = _account_ready(email='blake@example.com', seconds=SECONDS_PER_HOUR)

    monkeypatch.setattr(ai_router.CHAT_THROTTLES[0], 'limit', 2)

    allowed = [_chat(client, token).status_code for _ in range(2)]
    throttled = _chat(client, token)
    other = _chat(client, token_other)

    assert allowed == [200, 200]
    assert throttled.status_code == 429
    assert _error_code(throttled) == 'throttled'
    assert int(throttled['Retry-After']) > 0
    assert other.status_code == 200
    assert len(_authorizations(gateway)) == 3


@pytest.mark.parametrize(
    ('status', 'error_class'),
    [
        (400, GatewayRefusedError),
        (404, GatewayRefusedError),
        (413, GatewayRefusedError),
        (429, GatewayBusyError),
        (401, GatewayUnavailableError),
        (403, GatewayUnavailableError),
        (500, GatewayUnavailableError),
        (502, GatewayUnavailableError),
        (503, GatewayUnavailableError),
    ],
)
def test_each_ai_service_refusal_maps_to_one_error(status: int, error_class: type) -> None:
    assert status >= 400

    error = gateway_client._gateway_refusal(
        detail='{"error": {"message": "upstream"}}',
        path='/v1/chat/completions',
        status=status,
    )

    assert type(error) is error_class
    assert error.status != 401
    assert 'upstream' not in str(error)


def test_an_ai_service_failure_is_logged_with_its_reason_and_kept_from_the_app(
    caplog: pytest.LogCaptureFixture,
    client: Client,
    gateway: FakesServer,
) -> None:
    _, token = _account_ready(seconds=SECONDS_PER_HOUR)

    gateway.fakes.state.faults['gateway_down'] = True

    with caplog.at_level(logging.ERROR, logger='app.gateway.client'):
        response = _chat(client, token)

    assert response.status_code == 503
    assert 'The gateway is down.' in caplog.text
    assert 'The gateway is down.' not in response.content.decode()
