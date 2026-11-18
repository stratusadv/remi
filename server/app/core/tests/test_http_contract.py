from __future__ import annotations

import json
import time

import pytest

from types import MappingProxyType
from typing_extensions import TYPE_CHECKING

from django.test import Client

from app.account.models import Account
from harness.api import (
    ACCOUNT_ACTION_PATH,
    ACCOUNT_CHARGE_PATH,
    ACCOUNT_CHECKOUT_FINISH_PATH,
    ACCOUNT_CHECKOUT_PATH,
    ACCOUNT_PATH,
    ACCOUNT_PROMO_PATH,
    ACCOUNT_QUESTION_FINISH_PATH,
    ACCOUNT_QUESTION_PATH,
    FUNNEL_CLICK_PATH,
    FUNNEL_DOWNLOAD_PATH,
    FUNNEL_EMAIL_PATH,
    STRIPE_EVENT_PATH,
    account_create,
)
from harness.stripe import STRIPE_WEBHOOK_SECRET, stripe_event_payload, stripe_signature_header

if TYPE_CHECKING:
    from harness.stripe import StripeFake


pytestmark = pytest.mark.django_db
BODY_BYTES_OVER_LIMIT = 3_000_000
JOB_ID = '86dfb1d3b0140ecf2fd59075421f1cb5'
RETURN_PATH = '/checkout/return/'

PATHS_POST_ONLY = (
    ACCOUNT_ACTION_PATH,
    ACCOUNT_CHARGE_PATH,
    ACCOUNT_CHECKOUT_FINISH_PATH,
    ACCOUNT_CHECKOUT_PATH,
    ACCOUNT_PROMO_PATH,
    ACCOUNT_QUESTION_FINISH_PATH,
    ACCOUNT_QUESTION_PATH,
    FUNNEL_CLICK_PATH,
    FUNNEL_DOWNLOAD_PATH,
    FUNNEL_EMAIL_PATH,
    STRIPE_EVENT_PATH,
)

SECURITY_HEADERS = MappingProxyType({
    'Content-Security-Policy': (
        "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"
    ),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
})


def _csrf_enforced() -> Client:
    return Client(enforce_csrf_checks=True)


def test_the_app_endpoints_take_a_bearer_request_without_a_csrf_token(
    stripe_fake: StripeFake,
) -> None:
    client = _csrf_enforced()
    fields = {'email': 'avery@example.com', 'name': 'Avery', 'promo_code': '', 'region': 'CA-AB'}
    body = json.dumps(fields)
    created = client.post(ACCOUNT_PATH, data=body, content_type='application/json')
    token = created.json()['token']
    headers = {'Authorization': f'Bearer {token}'}

    posts = [
        (ACCOUNT_CHECKOUT_PATH, {'hours': 50}, 200),
        (ACCOUNT_CHECKOUT_FINISH_PATH, {'session_id': 'cs_test_1'}, 200),
        (ACCOUNT_PROMO_PATH, {'code': 'NOPE'}, 400),
        (ACCOUNT_CHARGE_PATH, {'job_id': JOB_ID, 'seconds': 60}, 402),
        (ACCOUNT_QUESTION_PATH, {}, 403),
        (ACCOUNT_QUESTION_FINISH_PATH, {'question_id': 1, 'tokens': 5}, 404),
    ]

    assert created.status_code == 201

    for path, payload, status in posts:
        data = json.dumps(payload)
        response = client.post(path, data=data, content_type='application/json', headers=headers)

        assert response.status_code == status, path
        assert 'CSRF' not in response.content.decode(), path

    assert len(stripe_fake.created) == 1


def test_the_stripe_webhook_takes_a_signed_event_without_a_csrf_token(
    stripe_fake: StripeFake,
) -> None:
    _ = stripe_fake
    client = _csrf_enforced()
    payload = stripe_event_payload(event_type='customer.created', session_id='cs_test_1')
    timestamp = int(time.time())
    header = stripe_signature_header(payload, secret=STRIPE_WEBHOOK_SECRET, timestamp=timestamp)
    headers = {'Stripe-Signature': header}

    response = client.post(
        STRIPE_EVENT_PATH,
        data=payload,
        content_type='application/json',
        headers=headers,
    )

    assert response.status_code == 200


def test_endpoints_refuse_a_method_they_do_not_serve(client: Client) -> None:
    for path in PATHS_POST_ONLY:
        response = client.get(path)

        assert response.status_code == 405, path

    response_put = client.put(ACCOUNT_PATH)
    response_delete = client.delete(ACCOUNT_PATH)
    response_post = client.post(RETURN_PATH)

    assert response_put.status_code == 405
    assert response_delete.status_code == 405
    assert response_post.status_code == 405


def test_a_body_over_the_upload_limit_is_refused_and_creates_nothing(client: Client) -> None:
    name = 'x' * BODY_BYTES_OVER_LIMIT
    fields = {'email': 'avery@example.com', 'name': name, 'promo_code': '', 'region': 'CA-AB'}
    body = json.dumps(fields)
    response = client.post(ACCOUNT_PATH, data=body, content_type='application/json')

    assert response.status_code == 400
    assert response.json()['error']['code'] == 'request_invalid'
    assert not Account.objects.exists()


def test_a_form_body_on_a_json_endpoint_is_refused_with_the_error_envelope(client: Client) -> None:
    fields = {'email': 'avery@example.com', 'name': 'Avery', 'promo_code': '', 'region': 'CA-AB'}
    response = client.post(ACCOUNT_PATH, data=fields)
    message = 'The request body is not JSON.'
    error = {'code': 'request_invalid', 'message': message, 'type': 'billing_error'}

    assert response.status_code == 400
    assert response.json() == {'error': error}
    assert not Account.objects.exists()


def test_pages_and_api_answers_carry_the_security_headers(client: Client) -> None:
    token = account_create(client)
    headers = {'Authorization': f'Bearer {token}'}
    responses = [client.get(RETURN_PATH), client.get(ACCOUNT_PATH, headers=headers)]

    for response in responses:
        for name, value in SECURITY_HEADERS.items():
            assert response[name] == value, (response.request['PATH_INFO'], name)


def test_api_answers_are_json_objects_whether_served_or_refused(client: Client) -> None:
    token = account_create(client)
    headers = {'Authorization': f'Bearer {token}'}
    detail = client.get(ACCOUNT_PATH, headers=headers)
    refused = client.get(ACCOUNT_PATH)

    for response in (detail, refused):
        assert response['Content-Type'] == 'application/json; charset=utf-8'
        assert isinstance(response.json(), dict)
