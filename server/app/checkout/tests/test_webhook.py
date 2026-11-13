from __future__ import annotations

import logging
import time

import pytest
import stripe

from typing_extensions import TYPE_CHECKING

from harness.api import account_create, account_get, checkout_start, stripe_event_deliver
from harness.fixtures import PRICE_HOURS
from harness.stripe import STRIPE_WEBHOOK_SECRET, stripe_event_payload, stripe_signature_header

if TYPE_CHECKING:
    from django.test import Client
    from pytest_django.fixtures import Settings

    from harness.stripe import StripeFake


pytestmark = pytest.mark.django_db
EVENT_COMPLETED = 'checkout.session.completed'
LOGGER_LEDGER_FACTORY = 'app.account.ledger.services.factory_service'
SECONDS_PER_HOUR = 3600
SIGNATURE_TOLERANCE_SECONDS = 300


def test_webhook_completion_waits_for_an_async_payment_to_succeed(
    caplog: pytest.LogCaptureFixture,
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER_LEDGER_FACTORY)

    token = account_create(client)
    session_id = checkout_start(client, hours=PRICE_HOURS, token=token)
    now = int(time.time())
    completed = stripe_event_payload(event_type=EVENT_COMPLETED, session_id=session_id)

    header_completed = stripe_signature_header(
        completed,
        secret=STRIPE_WEBHOOK_SECRET,
        timestamp=now,
    )

    waiting = stripe_event_deliver(client, header=header_completed, payload=completed)

    assert waiting.status_code == 200
    assert account_get(client, token)['balance_seconds'] == 0
    assert f'Checkout session {session_id} is not paid yet' in caplog.text

    stripe_fake.pay(session_id)

    succeeded = stripe_event_payload(
        event_type='checkout.session.async_payment_succeeded',
        session_id=session_id,
    )

    header_succeeded = stripe_signature_header(
        succeeded,
        secret=STRIPE_WEBHOOK_SECRET,
        timestamp=now,
    )

    paid = stripe_event_deliver(client, header=header_succeeded, payload=succeeded)

    assert paid.status_code == 200
    assert account_get(client, token)['balance_seconds'] == PRICE_HOURS * SECONDS_PER_HOUR


def test_webhook_signed_completion_credits_once_even_when_delivered_twice(
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    token = account_create(client)
    session_id = checkout_start(client, hours=PRICE_HOURS, token=token)

    stripe_fake.pay(session_id)

    payload = stripe_event_payload(event_type=EVENT_COMPLETED, session_id=session_id)
    now = int(time.time())
    header = stripe_signature_header(payload, secret=STRIPE_WEBHOOK_SECRET, timestamp=now)

    for _ in range(2):
        assert stripe_event_deliver(client, header=header, payload=payload).status_code == 200

    assert account_get(client, token)['balance_seconds'] == PRICE_HOURS * SECONDS_PER_HOUR


def test_webhook_unable_to_reach_stripe_fails_so_stripe_retries(
    caplog: pytest.LogCaptureFixture,
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    caplog.set_level(logging.ERROR, logger='app.checkout.client')

    token = account_create(client)
    session_id = checkout_start(client, hours=PRICE_HOURS, token=token)

    stripe_fake.pay(session_id)
    stripe_fake.retrieve_error = stripe.APIConnectionError('timed out')

    payload = stripe_event_payload(event_type=EVENT_COMPLETED, session_id=session_id)
    now = int(time.time())
    header = stripe_signature_header(payload, secret=STRIPE_WEBHOOK_SECRET, timestamp=now)
    response = stripe_event_deliver(client, header=header, payload=payload)

    assert response.status_code == 503
    assert 'could not return checkout session' in caplog.text
    assert account_get(client, token)['balance_seconds'] == 0


def test_webhook_unrelated_event_or_missing_secret_changes_nothing(
    client: Client,
    settings: Settings,
    stripe_fake: StripeFake,
) -> None:
    token = account_create(client)
    session_id = checkout_start(client, hours=PRICE_HOURS, token=token)

    stripe_fake.pay(session_id)

    payload = stripe_event_payload(event_type='payment_intent.created', session_id=session_id)
    now = int(time.time())
    header = stripe_signature_header(payload, secret=STRIPE_WEBHOOK_SECRET, timestamp=now)
    unrelated = stripe_event_deliver(client, header=header, payload=payload)

    settings.STRIPE_WEBHOOK_SECRET = ''

    unconfigured = stripe_event_deliver(client, header=header, payload=payload)

    assert unrelated.status_code == 200
    assert unconfigured.status_code == 503
    assert account_get(client, token)['balance_seconds'] == 0


def test_webhook_with_a_bad_signature_or_no_payload_credits_nothing(
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    token = account_create(client)
    session_id = checkout_start(client, hours=PRICE_HOURS, token=token)

    stripe_fake.pay(session_id)

    payload = stripe_event_payload(event_type=EVENT_COMPLETED, session_id=session_id)
    other = stripe_event_payload(event_type=EVENT_COMPLETED, session_id='cs_test_other')
    now = int(time.time())
    stale = now - SIGNATURE_TOLERANCE_SECONDS - 60
    header_valid = stripe_signature_header(payload, secret=STRIPE_WEBHOOK_SECRET, timestamp=now)
    empty = stripe_event_deliver(client, header=header_valid, payload='')
    fetched = client.get('/api/stripe/event/')

    headers = [
        stripe_signature_header(payload, secret='whsec_wrong', timestamp=now),
        stripe_signature_header(other, secret=STRIPE_WEBHOOK_SECRET, timestamp=now),
        stripe_signature_header(payload, secret=STRIPE_WEBHOOK_SECRET, timestamp=stale),
        '',
    ]

    for header in headers:
        assert stripe_event_deliver(client, header=header, payload=payload).status_code == 400

    assert empty.status_code == 400
    assert fetched.status_code == 405
    assert account_get(client, token)['balance_seconds'] == 0
