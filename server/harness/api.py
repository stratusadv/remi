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
BEACON_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=UTF-8'
FUNNEL_DOWNLOAD_PATH = '/api/v1/funnel/download/'
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
    body = {'email': email, 'name': 'Avery', 'promo_code': promo_code}
    response = api_post(client, ACCOUNT_PATH, body=body)

    if response.status_code != STATUS_CREATED:
        message = f'creating {email} answered {response.status_code}: {response.content!r}'
        raise AssertionError(message)

    return response.json()['token']


def account_get(client: Client, token: str) -> dict[str, object]:
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
    body = {'session_id': session_id}

    return api_post(client, ACCOUNT_CHECKOUT_FINISH_PATH, body=body, token=token)


def checkout_start(client: Client, *, hours: int, token: str) -> str:
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
    headers = {'Stripe-Signature': header}

    return client.post(
        STRIPE_EVENT_PATH,
        data=payload,
        content_type='application/json',
        headers=headers,
    )
