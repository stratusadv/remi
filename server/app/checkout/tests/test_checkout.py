from __future__ import annotations

import logging

import pytest
import stripe

from typing_extensions import TYPE_CHECKING

from pydantic import ValidationError
from stripe.params.checkout import SessionCreateParams

from app.account.constants import SECONDS_PER_HOUR
from app.account.ledger.models import AccountLedgerEntry
from app.account.models import Account
from app.account.tests.factories import create_test_account
from app.checkout.client import (
    CHECKOUT_SESSION_UNKNOWN_MESSAGE,
    checkout_session_create,
    stripe_client,
)
from app.core.exceptions import CheckoutUnknownError, PaymentsUnavailableError
from harness.api import (
    ACCOUNT_CHECKOUT_FINISH_PATH,
    ACCOUNT_CHECKOUT_PATH,
    account_create,
    account_get,
    api_post,
    checkout_finish,
    checkout_start,
)
from harness.fixtures import OFFERS, PRICE_CURRENCY, PRICE_HOURS
from harness.stripe import STRIPE_PUBLISHABLE_KEY, STRIPE_SECRET_KEY

if TYPE_CHECKING:
    from django.test import Client

    from pytest_django.fixtures import Settings

    from harness.stripe import StripeFake


pytestmark = pytest.mark.django_db
LOGGER_CLIENT = 'app.checkout.client'
RETURN_PATH = '/checkout/return/'
RETURN_URL = f'http://testserver{RETURN_PATH}'
PURCHASE_SECONDS = PRICE_HOURS * SECONDS_PER_HOUR


def test_checkout_charges_the_configured_price_of_the_pack_chosen(
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    token = account_create(client)
    account = Account.objects.get()

    for index, (hours, price_cents) in enumerate(OFFERS):
        body = {'hours': hours}
        response = api_post(client, ACCOUNT_CHECKOUT_PATH, body=body, token=token)
        parameters = stripe_fake.created[index]
        session_id = f'cs_test_{index + 1}'

        metadata = {
            'account_id': str(account.pk),
            'app': 'remi',
            'seconds': str(hours * SECONDS_PER_HOUR),
        }

        price = {
            'currency': PRICE_CURRENCY,
            'product_data': {'name': f'remi: {hours} hours of transcription'},
            'unit_amount': price_cents,
        }

        line_item = {'price_data': price, 'quantity': 1}

        assert parameters == {
            'allowed_payment_method_types': ['card'],
            'client_reference_id': str(account.pk),
            'customer_email': 'avery@example.com',
            'line_items': [line_item],
            'metadata': metadata,
            'mode': 'payment',
            'return_url': RETURN_URL,
            'ui_mode': 'elements',
        }

        started = {'client_secret': f'{session_id}_secret_remi', 'session_id': session_id}

        assert response.status_code == 200
        assert response.json() == started

    assert len(stripe_fake.created) == len(OFFERS)


def test_checkout_return_page_answers_a_redirect_that_card_payments_never_make(
    client: Client,
) -> None:
    returned = client.get(RETURN_PATH)
    posted = client.post(RETURN_PATH)

    assert returned.status_code == 200
    assert returned['Content-Type'] == 'text/plain; charset=utf-8'
    assert b'Payment received' in returned.content
    assert posted.status_code == 405


def test_checkout_refuses_a_pack_that_is_not_on_offer(
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    token = account_create(client)
    bodies = [{'hours': 49}, {'hours': 0}, {'hours': -50}, {'hours': '50'}, {'hours': 50.5}, {}]

    for body in bodies:
        response = api_post(client, ACCOUNT_CHECKOUT_PATH, body=body, token=token)

        assert response.status_code == 400
        assert response.json()['error']['code'] == 'request_invalid'

    assert stripe_fake.created == []


def test_checkout_client_refuses_a_session_that_is_not_one_payment_for_one_account(
    stripe_fake: StripeFake,
) -> None:
    subscription = SessionCreateParams(
        client_reference_id='7',
        mode='subscription',
        ui_mode='elements',
    )

    hosted = SessionCreateParams(client_reference_id='7', mode='payment', ui_mode='hosted_page')
    unclaimed = SessionCreateParams(client_reference_id='', mode='payment', ui_mode='elements')
    unreturnable = SessionCreateParams(client_reference_id='7', mode='payment', ui_mode='elements')

    relative = SessionCreateParams(
        client_reference_id='7',
        mode='payment',
        return_url='/checkout/return/',
        ui_mode='elements',
    )

    refusals = (
        (subscription, 'one-time payment'),
        (hosted, 'paid inside remi'),
        (unclaimed, 'names the account'),
        (unreturnable, 'absolute return_url'),
        (relative, 'absolute return_url'),
    )

    for parameters, message in refusals:
        with pytest.raises(ValueError, match=message):
            checkout_session_create(parameters)

    assert stripe_fake.created == []


def test_checkout_finish_credits_a_paid_session_once_however_often_it_is_sent(
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    token = account_create(client)
    session_id = checkout_start(client, hours=PRICE_HOURS, token=token)

    stripe_fake.pay(session_id)

    for _ in range(2):
        response = checkout_finish(client, session_id=session_id, token=token)

        assert response.status_code == 200
        assert response.json()['paid'] is True
        assert response.json()['account']['balance_seconds'] == PURCHASE_SECONDS

    assert account_get(client, token)['balance_seconds'] == PURCHASE_SECONDS
    assert AccountLedgerEntry.objects.purchases().count() == 1


def test_checkout_finish_credits_the_hours_of_each_pack_bought(
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    token = account_create(client)
    hours_bought = (10, 200, 10)

    for hours in hours_bought:
        session_id = checkout_start(client, hours=hours, token=token)

        stripe_fake.pay(session_id)

        response = checkout_finish(client, session_id=session_id, token=token)

        assert response.status_code == 200
        assert response.json()['paid'] is True

    balance_seconds = account_get(client, token)['balance_seconds']

    assert balance_seconds == sum(hours_bought) * SECONDS_PER_HOUR
    assert AccountLedgerEntry.objects.purchases().count() == len(hours_bought)


def test_checkout_finish_refuses_a_request_without_a_session(
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    token = account_create(client)
    body_empty = {}
    body_named = {'session_id': 'cs_test_1'}
    headers = {'Authorization': f'Bearer {token}'}
    fetched = client.get(ACCOUNT_CHECKOUT_FINISH_PATH, headers=headers)
    empty = api_post(client, ACCOUNT_CHECKOUT_FINISH_PATH, body=body_empty, token=token)
    anonymous = api_post(client, ACCOUNT_CHECKOUT_FINISH_PATH, body=body_named)

    assert fetched.status_code == 405
    assert empty.status_code == 400
    assert empty.json()['error']['message'] == 'The request has no session_id.'
    assert anonymous.status_code == 401
    assert stripe_fake.created == []


def test_checkout_finish_treats_another_accounts_session_as_unknown(
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    owner = account_create(client)
    other = account_create(client, email='riley@example.com')
    session_id = checkout_start(client, hours=PRICE_HOURS, token=owner)

    stripe_fake.pay(session_id)

    refused = checkout_finish(client, session_id=session_id, token=other)
    missing = checkout_finish(client, session_id='cs_test_missing', token=other)

    assert refused.status_code == 404
    assert refused.json() == missing.json()
    assert refused.json()['error']['message'] == CHECKOUT_SESSION_UNKNOWN_MESSAGE
    assert account_get(client, owner)['balance_seconds'] == 0
    assert account_get(client, other)['balance_seconds'] == 0
    assert AccountLedgerEntry.objects.purchases().count() == 0


def test_checkout_never_serves_a_secret_key_set_as_the_publishable_key(
    client: Client,
    settings: Settings,
    stripe_fake: StripeFake,
) -> None:
    token = account_create(client)
    account = account_get(client, token)

    settings.STRIPE_PUBLISHABLE_KEY = STRIPE_SECRET_KEY

    with pytest.raises(ValidationError, match='other than a Stripe publishable key'):
        account_get(client, token)

    body = {'hours': PRICE_HOURS}
    started = api_post(client, ACCOUNT_CHECKOUT_PATH, body=body, token=token)

    assert account['publishable_key'] == STRIPE_PUBLISHABLE_KEY
    assert started.status_code == 200
    assert STRIPE_SECRET_KEY.encode() not in started.content
    assert len(stripe_fake.created) == 1


def test_checkout_paid_with_malformed_metadata_credits_nothing(stripe_fake: StripeFake) -> None:
    account = create_test_account(email='metadata@example.com', seconds=SECONDS_PER_HOUR)
    account_id = str(account.pk)

    metadatas = [
        {'account_id': account_id},
        {'seconds': '3600'},
        {'account_id': account_id, 'seconds': '0'},
        {'account_id': account_id, 'seconds': '-3600'},
        {'account_id': account_id, 'seconds': '03600'},
        {'account_id': account_id, 'seconds': '1e3'},
        {'account_id': account_id, 'seconds': '9' * 19},
        {'account_id': '0', 'seconds': '3600'},
        {'account_id': '999999', 'seconds': '3600'},
    ]

    for index, metadata in enumerate(metadatas):
        session_id = f'cs_test_metadata{index}'
        metadata_owned = {**metadata, 'app': 'remi'}

        stripe_fake.session_add(
            metadata=metadata_owned,
            payment_status='paid',
            session_id=session_id,
        )

        with pytest.raises(CheckoutUnknownError):
            AccountLedgerEntry.services.factory.purchase_from_session(session_id)

    assert account.ledger_entries.balance_seconds() == SECONDS_PER_HOUR


def test_checkout_finish_refuses_a_paid_session_another_app_started(
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    token = account_create(client)
    account = Account.objects.get()
    metadata = {'account_id': str(account.pk), 'seconds': str(PURCHASE_SECONDS)}

    stripe_fake.session_add(
        client_reference_id=str(account.pk),
        metadata=metadata,
        payment_status='paid',
        session_id='cs_test_foreign',
    )

    refused = checkout_finish(client, session_id='cs_test_foreign', token=token)

    assert refused.status_code == 404
    assert refused.json()['error']['code'] == 'checkout_unknown'
    assert account_get(client, token)['balance_seconds'] == 0


def test_checkout_refused_by_stripe_reports_payments_unavailable(
    caplog: pytest.LogCaptureFixture,
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    caplog.set_level(logging.ERROR, logger=LOGGER_CLIENT)

    stripe_fake.create_error = stripe.APIConnectionError('connection reset')
    token = account_create(client)
    body = {'hours': PRICE_HOURS}
    response = api_post(client, ACCOUNT_CHECKOUT_PATH, body=body, token=token)

    assert response.status_code == 503
    assert response.json()['error']['code'] == 'payments_unavailable'
    assert 'refused a checkout session' in caplog.text


def test_checkout_reuses_one_stripe_client_per_secret_key(settings: Settings) -> None:
    settings.STRIPE_SECRET_KEY = STRIPE_SECRET_KEY
    first = stripe_client()
    again = stripe_client()

    settings.STRIPE_SECRET_KEY = f'{STRIPE_SECRET_KEY}_rotated'
    rotated = stripe_client()

    assert again is first
    assert rotated is not first
    assert stripe_client() is rotated

    settings.STRIPE_SECRET_KEY = ''

    with pytest.raises(PaymentsUnavailableError):
        stripe_client()


def test_checkout_unpaid_unknown_or_unreachable_credits_nothing(
    caplog: pytest.LogCaptureFixture,
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    caplog.set_level(logging.ERROR, logger=LOGGER_CLIENT)

    token = account_create(client)
    session_id = checkout_start(client, hours=PRICE_HOURS, token=token)
    unpaid = checkout_finish(client, session_id=session_id, token=token)
    unknown = checkout_finish(client, session_id='cs_test_missing', token=token)
    malformed = checkout_finish(client, session_id='<script>', token=token)

    assert unpaid.status_code == 200
    assert unpaid.json()['paid'] is False
    assert unknown.status_code == 404
    assert malformed.status_code == 404
    assert b'script' not in malformed.content

    stripe_fake.pay(session_id)
    stripe_fake.retrieve_error = stripe.APIConnectionError('timed out')

    unreachable = checkout_finish(client, session_id=session_id, token=token)

    assert unreachable.status_code == 503
    assert 'could not return checkout session' in caplog.text
    assert account_get(client, token)['balance_seconds'] == 0


def test_checkout_without_both_stripe_keys_reports_payments_unavailable(
    client: Client,
    settings: Settings,
    stripe_fake: StripeFake,
) -> None:
    token = account_create(client)
    halves = ((STRIPE_PUBLISHABLE_KEY, ''), ('', STRIPE_SECRET_KEY))
    body = {'hours': PRICE_HOURS}

    for publishable_key, secret_key in halves:
        settings.STRIPE_PUBLISHABLE_KEY = publishable_key
        settings.STRIPE_SECRET_KEY = secret_key
        response = api_post(client, ACCOUNT_CHECKOUT_PATH, body=body, token=token)
        account = account_get(client, token)

        assert response.status_code == 503
        assert response.json()['error']['code'] == 'payments_unavailable'
        assert account['payments'] is False
        assert account['publishable_key'] == ''

    assert stripe_fake.created == []
