from __future__ import annotations

import json

import pytest

from typing_extensions import TYPE_CHECKING
from urllib.parse import urlencode

from harness.world.constants import (
    WORLD_GATEWAY_KEY_NOTES,
    WORLD_GATEWAY_KEY_TRANSCRIPTION,
    WORLD_SENDGRID_API_KEY,
    WORLD_STRIPE_SECRET_KEY,
)
from harness.world.fakes import (
    GATEWAY_ANSWER,
    GATEWAY_STREAM_TOKENS,
    GATEWAY_TRANSCRIPT,
    fakes_start,
    form_nested,
)
from harness.world.http import http_json, http_request

if TYPE_CHECKING:
    from collections.abc import Generator

    from harness.world.fakes import FakesServer
    from harness.world.http import Reply


FORM_CONFLICTING = (('mode', 'payment'), ('mode[inner]', 'x'))

MULTIPART_MODEL = (
    b'--x\r\nContent-Disposition: form-data; name="model"\r\n\r\nstratus.listen\r\n--x--\r\n'
)

SESSION_FORM = (
    ('allowed_payment_method_types[0]', 'card'),
    ('client_reference_id', '7'),
    ('customer_email', 'avery@example.com'),
    ('line_items[0][price_data][currency]', 'cad'),
    ('line_items[0][price_data][product_data][name]', 'remi: 10 hours of transcription'),
    ('line_items[0][price_data][unit_amount]', '1000'),
    ('line_items[0][quantity]', '1'),
    ('metadata[account_id]', '7'),
    ('metadata[app]', 'remi'),
    ('metadata[seconds]', '36000'),
    ('mode', 'payment'),
    ('return_url', 'http://127.0.0.1:47801/checkout/return/'),
    ('ui_mode', 'elements'),
)


@pytest.fixture
def fakes() -> Generator[FakesServer]:
    server = fakes_start(port=0, remi_url='http://127.0.0.1:9')

    try:
        yield server
    finally:
        server.stop()


def _gateway(fakes: FakesServer, path: str, payload: object, *, key: str) -> Reply:
    assert path.startswith('/')
    assert isinstance(payload, dict)
    assert '\r' not in key
    assert '\n' not in key

    headers = {'Authorization': f'Bearer {key}'}
    return http_json(f'{fakes.url}{path}', headers=headers, method='POST', payload=payload)


def _session_get(fakes: FakesServer, session_id: str, *, signed: bool = True) -> Reply:
    assert '/' not in session_id

    headers = _stripe_headers() if signed else {}
    return http_request(f'{fakes.url}/v1/checkout/sessions/{session_id}', headers=headers)


def _stripe_headers() -> dict[str, str]:
    return {
        'Authorization': f'Bearer {WORLD_STRIPE_SECRET_KEY}',
        'Content-Type': 'application/x-www-form-urlencoded',
    }


def test_stripe_form_keys_nest_into_the_objects_the_sdk_meant() -> None:
    nested = form_nested(SESSION_FORM)

    assert nested['metadata'] == {'account_id': '7', 'app': 'remi', 'seconds': '36000'}
    assert nested['line_items']['0']['price_data']['unit_amount'] == '1000'
    assert nested['allowed_payment_method_types'] == {'0': 'card'}

    with pytest.raises(TypeError, match='nests under a value'):
        form_nested(FORM_CONFLICTING)


def test_stripe_fake_creates_retrieves_and_refuses_like_stripe(fakes: FakesServer) -> None:
    body = urlencode(SESSION_FORM).encode()
    headers = _stripe_headers()

    created = http_request(
        f'{fakes.url}/v1/checkout/sessions',
        body=body,
        headers=headers,
        method='POST',
    )

    session = created.json()
    retrieved = _session_get(fakes, session['id'])

    assert created.status == 200
    assert session['client_secret'] == f'{session["id"]}_secret_world'
    assert session['amount_total'] == 1000
    assert session['payment_status'] == 'unpaid'
    assert retrieved.json() == session

    missing = _session_get(fakes, 'cs_test_missing')
    unsigned = _session_get(fakes, session['id'], signed=False)

    assert missing.status == 404
    assert missing.json()['error']['type'] == 'invalid_request_error'
    assert unsigned.status == 401

    fakes.fakes.session_pay(session['id'], webhook=False)

    paid = _session_get(fakes, session['id'])

    assert paid.json()['payment_status'] == 'paid'


def test_sendgrid_fake_keeps_each_message_and_refuses_a_wrong_key(fakes: FakesServer) -> None:
    content = [
        {'type': 'text/plain', 'value': 'Hello'},
        {'type': 'text/html', 'value': '<p>Hello</p>'},
    ]

    payload = {
        'content': content,
        'from': {'email': 'noreply@remirememberthat.com'},
        'personalizations': [{'to': [{'email': 'avery@example.com'}]}],
        'subject': 'Download remi',
    }

    url = f'{fakes.url}/v3/mail/send'
    headers = {'Authorization': f'Bearer {WORLD_SENDGRID_API_KEY}'}
    sent = http_json(url, headers=headers, method='POST', payload=payload)
    refused = http_json(url, method='POST', payload=payload)
    state = http_request(f'{fakes.url}/control/state').json()

    message = {
        'html': '<p>Hello</p>',
        'subject': 'Download remi',
        'text': 'Hello',
        'to': ['avery@example.com'],
    }

    assert sent.status == 202
    assert refused.status == 401
    assert state['sendgrid_messages'] == [message]


def test_gateway_fake_answers_each_call_the_app_makes(fakes: FakesServer) -> None:
    messages = [
        {'content': 'system', 'role': 'system'},
        {'content': 'What did Morgan agree to?', 'role': 'user'},
    ]

    response_format = {'json_schema': {'name': 'meeting_search'}, 'type': 'json_schema'}
    parse = {'messages': messages, 'response_format': response_format}
    title = {'messages': [{'content': 'Write a short title for this meeting.', 'role': 'system'}]}
    embeddings = {'input': ['budget friday', 'room booking'], 'model': 'stratus.embed'}
    parsed = _gateway(fakes, '/v1/chat/completions', parse, key=WORLD_GATEWAY_KEY_NOTES)
    titled = _gateway(fakes, '/v1/chat/completions', title, key=WORLD_GATEWAY_KEY_NOTES)
    embedded = _gateway(fakes, '/v1/embeddings', embeddings, key=WORLD_GATEWAY_KEY_NOTES)
    headers = {'Authorization': f'Bearer {WORLD_GATEWAY_KEY_TRANSCRIPTION}'}

    transcribed = http_request(
        f'{fakes.url}/v1/audio/transcriptions',
        body=MULTIPART_MODEL,
        headers=headers,
        method='POST',
    )

    search = json.loads(parsed.json()['choices'][0]['message']['content'])
    vectors = [datum['embedding'] for datum in embedded.json()['data']]
    question = {'names': [], 'queries': ['budget'], 'question': 'What did Morgan agree to?'}

    assert search == question
    assert titled.json()['choices'][0]['message']['content'] == 'Weekly planning sync'
    assert len(vectors) == 2
    assert {len(vector) for vector in vectors} == {32}
    assert transcribed.json() == {'text': GATEWAY_TRANSCRIPT}


def test_gateway_fake_streams_the_answer_then_the_token_total(fakes: FakesServer) -> None:
    messages = [{'content': 'Answer from the notes.', 'role': 'system'}]
    payload = {'messages': messages, 'stream': True}
    streamed = _gateway(fakes, '/v1/chat/completions', payload, key=WORLD_GATEWAY_KEY_NOTES)
    blocks = streamed.body.decode().split('\n\n')
    events = [event.removeprefix('data: ') for event in blocks if event]
    pieces = [json.loads(event) for event in events[:-1]]
    deltas = [piece['choices'][0]['delta']['content'] for piece in pieces if piece['choices']]

    assert events[-1] == '[DONE]'
    assert ''.join(deltas).strip() == GATEWAY_ANSWER
    assert pieces[-1]['usage']['total_tokens'] == GATEWAY_STREAM_TOKENS


def test_gateway_fake_refuses_a_wrong_key_and_goes_down_on_request(fakes: FakesServer) -> None:
    payload = {'input': 'budget', 'model': 'stratus.embed'}
    refused = _gateway(fakes, '/v1/embeddings', payload, key='wrong-key')

    http_json(f'{fakes.url}/control/faults', method='POST', payload={'gateway_down': True})

    down = _gateway(fakes, '/v1/embeddings', payload, key=WORLD_GATEWAY_KEY_NOTES)

    http_json(f'{fakes.url}/control/reset', method='POST', payload={})

    restored = _gateway(fakes, '/v1/embeddings', payload, key=WORLD_GATEWAY_KEY_NOTES)

    assert refused.status == 401
    assert down.status == 503
    assert restored.status == 200
