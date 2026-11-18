from __future__ import annotations

from typing_extensions import TYPE_CHECKING

if TYPE_CHECKING:
    from django.test import Client
    from django.test.client import _MonkeyPatchedWSGIResponse


ACCOUNT_CHARGE_PATH = '/api/v1/account/charge/'
ACCOUNT_CHECKOUT_FINISH_PATH = '/api/v1/account/checkout/finish/'
ACCOUNT_CHECKOUT_PATH = '/api/v1/account/checkout/'
ACCOUNT_PATH = '/api/v1/account/'
ACCOUNT_PROMO_PATH = '/api/v1/account/promo/'
ACCOUNT_QUESTION_FINISH_PATH = '/api/v1/account/question/finish/'
ACCOUNT_QUESTION_PATH = '/api/v1/account/question/'
AI_CHAT_PATH = '/api/v1/ai/v1/chat/completions'
AI_EMBEDDINGS_PATH = '/api/v1/ai/v1/embeddings'
AI_MODELS_PATH = '/api/v1/ai/v1/models'
AI_TRANSCRIPTION_PATH = '/api/v1/ai/v1/audio/transcriptions'
BEACON_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=UTF-8'
BODY_BYTES_MAX = 64 << 20
FUNNEL_DOWNLOAD_PATH = '/api/v1/funnel/download/'
FUNNEL_EMAIL_PATH = '/api/v1/funnel/email/'
FUNNEL_VISIT_PATH = '/api/v1/funnel/visit/'
STATUS_CREATED = 201
STATUS_OK = 200
STRIPE_EVENT_PATH = '/api/stripe/event/'


def account_create(
    client: Client,
    *,
    email: str = 'avery@example.com',
    promo_code: str = '',
) -> str:
    if not isinstance(email, str):
        message = f'email must be a str, not {type(email).__name__}'
        raise TypeError(message)

    if not isinstance(promo_code, str):
        message = f'promo_code must be a str, not {type(promo_code).__name__}'
        raise TypeError(message)

    body = {'email': email, 'name': 'Avery', 'promo_code': promo_code, 'region': 'CA-AB'}
    response = api_post(client, ACCOUNT_PATH, body=body)

    if response.status_code != STATUS_CREATED:
        message = f'creating {email} answered {response.status_code}: {response.content!r}'
        raise AssertionError(message)

    return response.json()['token']


def account_get(client: Client, token: str) -> dict[str, object]:
    if '\r' in token:
        message = f'token must not carry a carriage return: {token!r}'
        raise ValueError(message)

    if '\n' in token:
        message = f'token must not carry a line feed: {token!r}'
        raise ValueError(message)

    headers = {'Authorization': f'Bearer {token}'}
    response = client.get(ACCOUNT_PATH, headers=headers)

    if response.status_code != STATUS_OK:
        message = f'reading the account answered {response.status_code}: {response.content!r}'
        raise AssertionError(message)

    return response.json()


def api_post(
    client: Client,
    path: str,
    *,
    body: object = None,
    token: str = '',
) -> _MonkeyPatchedWSGIResponse:
    if not path.startswith('/'):
        message = f'path must start with a slash: {path!r}'
        raise ValueError(message)

    if not isinstance(body, dict | list | tuple | str | bytes | None):
        message = f'body must be JSON data, JSON text, or encoded bytes, not {type(body).__name__}'
        raise TypeError(message)

    if '\r' in token:
        message = f'token must not carry a carriage return: {token!r}'
        raise ValueError(message)

    if '\n' in token:
        message = f'token must not carry a line feed: {token!r}'
        raise ValueError(message)

    headers = {} if token == '' else {'Authorization': f'Bearer {token}'}

    return client.post(
        path,
        data=body,
        content_type='application/json',
        headers=headers,
    )


def checkout_finish(
    client: Client,
    *,
    session_id: str,
    token: str,
) -> _MonkeyPatchedWSGIResponse:
    if not isinstance(session_id, str):
        message = f'session_id must be a str, not {type(session_id).__name__}'
        raise TypeError(message)

    if '\r' in token:
        message = f'token must not carry a carriage return: {token!r}'
        raise ValueError(message)

    if '\n' in token:
        message = f'token must not carry a line feed: {token!r}'
        raise ValueError(message)

    body = {'session_id': session_id}
    return api_post(client, ACCOUNT_CHECKOUT_FINISH_PATH, body=body, token=token)


def checkout_start(client: Client, *, hours: int, token: str) -> str:
    if not isinstance(hours, int):
        message = f'hours must be an int, not {type(hours).__name__}'
        raise TypeError(message)

    if '\r' in token:
        message = f'token must not carry a carriage return: {token!r}'
        raise ValueError(message)

    if '\n' in token:
        message = f'token must not carry a line feed: {token!r}'
        raise ValueError(message)

    body = {'hours': hours}
    response = api_post(client, ACCOUNT_CHECKOUT_PATH, body=body, token=token)

    if response.status_code != STATUS_OK:
        message = f'starting a checkout answered {response.status_code}: {response.content!r}'
        raise AssertionError(message)

    return response.json()['session_id']


def stripe_event_deliver(
    client: Client,
    *,
    header: str,
    payload: str,
) -> _MonkeyPatchedWSGIResponse:
    if '\r' in header:
        message = f'header must not carry a carriage return: {header!r}'
        raise ValueError(message)

    if '\n' in header:
        message = f'header must not carry a line feed: {header!r}'
        raise ValueError(message)

    if len(payload.encode()) > BODY_BYTES_MAX:
        message = f'payload must be at most {BODY_BYTES_MAX} bytes, not {len(payload.encode())}'
        raise ValueError(message)

    headers = {'Stripe-Signature': header}

    return client.post(
        STRIPE_EVENT_PATH,
        data=payload,
        content_type='application/json',
        headers=headers,
    )
