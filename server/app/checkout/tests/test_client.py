from __future__ import annotations

import logging
import re
import time

import pytest
import stripe

from typing_extensions import TYPE_CHECKING

from stripe.params.checkout import SessionCreateParams, SessionListParams

from app.account.ledger.models import AccountLedgerEntry
from app.checkout import client as checkout_client
from app.core.exceptions import (
    CheckoutUnknownError,
    PaymentsUnavailableError,
    PaymentUnknownError,
    RequestInvalidError,
)
from harness.api import ACCOUNT_CHECKOUT_PATH, account_create, api_post
from harness.stripe import (
    STRIPE_PUBLISHABLE_KEY,
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
    stripe_event_payload,
    stripe_signature_header,
)

if TYPE_CHECKING:
    from django.test import Client

    from pytest_django.fixtures import Settings

    from harness.stripe import StripeFake


pytestmark = pytest.mark.django_db
MESSAGE_INVALID = 'The webhook signature or payload is invalid.'
RETURN_URL = 'http://testserver/checkout/return/'


def _parameters() -> SessionCreateParams:
    return SessionCreateParams(
        client_reference_id='7',
        line_items=[],
        mode='payment',
        return_url=RETURN_URL,
        ui_mode='elements',
    )


def _session(*, client_secret: str, session_id: str) -> stripe.checkout.Session:
    assert session_id
    assert client_secret == '' or client_secret.startswith(f'{session_id}_secret_')

    values = {
        'client_secret': client_secret,
        'id': session_id,
        'metadata': {'app': 'remi'},
        'object': 'checkout.session',
        'payment_status': 'unpaid',
    }

    return stripe.checkout.Session.construct_from(values, STRIPE_SECRET_KEY)


def test_shared_stripe_client_needs_a_secret_key_and_an_http_api_base() -> None:
    with pytest.raises(ValueError, match='a Stripe client needs a secret key'):
        checkout_client._stripe_client_shared(api_base='', secret_key='')

    with pytest.raises(ValueError, match='must be an http or https address'):
        checkout_client._stripe_client_shared(
            api_base='ftp://stripe.example.test',
            secret_key=STRIPE_SECRET_KEY,
        )

    api_base = 'https://stripe.example.test'
    secure = checkout_client._stripe_client_shared(api_base=api_base, secret_key=STRIPE_SECRET_KEY)
    again = checkout_client._stripe_client_shared(api_base=api_base, secret_key=STRIPE_SECRET_KEY)

    assert secure._requestor.base_addresses['api'] == api_base
    assert again is secure


def test_stripe_client_talks_to_stripe_unless_settings_name_another_api_base(
    settings: Settings,
) -> None:
    settings.STRIPE_SECRET_KEY = STRIPE_SECRET_KEY
    settings.STRIPE_API_BASE = ''
    default = checkout_client.stripe_client()

    settings.STRIPE_API_BASE = 'http://127.0.0.1:47802'
    local = checkout_client.stripe_client()
    again = checkout_client.stripe_client()

    assert default._requestor.base_addresses['api'] == stripe.DEFAULT_API_BASE
    assert local._requestor.base_addresses['api'] == 'http://127.0.0.1:47802'
    assert local is not default
    assert again is local


def test_stripe_client_without_a_secret_key_reports_payments_unavailable(
    settings: Settings,
) -> None:
    settings.STRIPE_SECRET_KEY = ''

    message = re.escape(checkout_client.PAYMENTS_UNCONFIGURED_MESSAGE)

    assert not checkout_client.payments_configured()

    with pytest.raises(PaymentsUnavailableError, match=message):
        checkout_client.stripe_client()

    settings.STRIPE_SECRET_KEY = STRIPE_SECRET_KEY

    shared = checkout_client._stripe_client_shared(
        api_base=settings.STRIPE_API_BASE,
        secret_key=STRIPE_SECRET_KEY,
    )

    configured = checkout_client.stripe_client()

    assert configured is shared


def test_a_session_stripe_returns_without_a_checkout_id_is_a_programming_error(
    monkeypatch: pytest.MonkeyPatch,
    stripe_fake: StripeFake,
) -> None:
    created = checkout_client.checkout_session_create(_parameters())
    session = _session(client_secret='pi_1_secret_remi', session_id='pi_1')

    assert created.id == 'cs_test_1'
    assert checkout_client.CHECKOUT_SESSION_PATTERN.fullmatch(session.id) is None

    monkeypatch.setattr(stripe_fake, 'create', lambda _: session)

    with pytest.raises(RuntimeError, match="returned a checkout session with the id 'pi_1'"):
        checkout_client.checkout_session_create(_parameters())


def test_a_session_stripe_returns_without_a_client_secret_cannot_be_paid(
    client: Client,
    monkeypatch: pytest.MonkeyPatch,
    stripe_fake: StripeFake,
) -> None:
    token = account_create(client)
    session = _session(client_secret='', session_id='cs_test_1')

    monkeypatch.setattr(stripe_fake, 'create', lambda _: session)

    body = {'hours': 50}
    response = api_post(client, ACCOUNT_CHECKOUT_PATH, body=body, token=token)
    message = 'Stripe returned a checkout session without a client secret.'
    error = {'code': 'payments_unavailable', 'message': message, 'type': 'billing_error'}

    assert response.status_code == 503
    assert response.json() == {'error': error}


def test_session_retrieve_refuses_an_id_that_is_not_a_checkout_session(
    stripe_fake: StripeFake,
) -> None:
    for session_id in ('', 'cs_', 'pi_123', 'cs_test 1', 'cs_test/../x', 'cs_' + 'a' * 251):
        message = re.escape(checkout_client.CHECKOUT_SESSION_INVALID_MESSAGE)

        with pytest.raises(CheckoutUnknownError, match=message):
            checkout_client.checkout_session_retrieve(session_id)

    assert stripe_fake.sessions == {}

    metadata = {'app': 'remi'}

    for session_id in ('cs_a', 'cs_' + 'a' * 250):
        stripe_fake.session_add(metadata=metadata, payment_status='unpaid', session_id=session_id)

        session = checkout_client.checkout_session_retrieve(session_id)

        assert session.id == session_id


def test_session_retrieve_that_returns_another_session_is_a_programming_error(
    monkeypatch: pytest.MonkeyPatch,
    stripe_fake: StripeFake,
) -> None:
    metadata = {'app': 'remi'}
    other = _session(client_secret='cs_test_other_secret_remi', session_id='cs_test_other')

    stripe_fake.session_add(metadata=metadata, payment_status='unpaid', session_id='cs_test_1')

    session = checkout_client.checkout_session_retrieve('cs_test_1')

    assert session.id == 'cs_test_1'

    monkeypatch.setattr(stripe_fake, 'retrieve', lambda _: other)

    with pytest.raises(RuntimeError, match='returned checkout session cs_test_other for cs_test_1'):
        checkout_client.checkout_session_retrieve('cs_test_1')


def test_session_retrieve_reports_an_unreachable_stripe_as_unavailable(
    caplog: pytest.LogCaptureFixture,
    stripe_fake: StripeFake,
) -> None:
    stripe_fake.retrieve_error = stripe.APIConnectionError('Network down')
    message = 'Stripe could not confirm the payment yet. Try again in a minute.'

    with pytest.raises(PaymentsUnavailableError, match=re.escape(message)):
        checkout_client.checkout_session_retrieve('cs_test_1')

    assert 'Stripe could not return checkout session cs_test_1' in caplog.text
    assert [record.levelno for record in caplog.records] == [logging.ERROR]


def test_webhook_construct_refuses_a_missing_payload_or_signature(
    stripe_fake: StripeFake,
) -> None:
    _ = stripe_fake

    missing_payload = re.escape(checkout_client.WEBHOOK_PAYLOAD_MISSING_MESSAGE)
    missing_signature = re.escape(checkout_client.WEBHOOK_SIGNATURE_MISSING_MESSAGE)

    with pytest.raises(RequestInvalidError, match=missing_payload):
        checkout_client.webhook_event_construct(payload=b'', signature='t=1,v1=abc')

    with pytest.raises(RequestInvalidError, match=missing_signature):
        checkout_client.webhook_event_construct(payload=b'{}', signature='')


def test_webhook_construct_refuses_a_signed_payload_that_is_not_json(
    stripe_fake: StripeFake,
) -> None:
    _ = stripe_fake
    payload = 'this is not json'
    timestamp = int(time.time())
    header = stripe_signature_header(payload, secret=STRIPE_WEBHOOK_SECRET, timestamp=timestamp)

    assert stripe.WebhookSignature.verify_header(payload, header, STRIPE_WEBHOOK_SECRET)

    with pytest.raises(RequestInvalidError, match=re.escape(MESSAGE_INVALID)):
        checkout_client.webhook_event_construct(payload=payload.encode(), signature=header)


def test_webhook_construct_refuses_a_signature_older_than_the_tolerance(
    stripe_fake: StripeFake,
) -> None:
    _ = stripe_fake
    payload = stripe_event_payload(event_type='checkout.session.completed', session_id='cs_test_1')
    stale = int(time.time()) - stripe.Webhook.DEFAULT_TOLERANCE - 60
    header = stripe_signature_header(payload, secret=STRIPE_WEBHOOK_SECRET, timestamp=stale)

    assert stripe.WebhookSignature.verify_header(payload, header, STRIPE_WEBHOOK_SECRET)

    with pytest.raises(RequestInvalidError, match=re.escape(MESSAGE_INVALID)):
        checkout_client.webhook_event_construct(payload=payload.encode(), signature=header)

    assert not AccountLedgerEntry.objects.exists()


def test_webhook_construct_accepts_a_fresh_signature_and_returns_the_event(
    stripe_fake: StripeFake,
) -> None:
    _ = stripe_fake
    payload = stripe_event_payload(event_type='checkout.session.completed', session_id='cs_test_1')
    timestamp = int(time.time())
    header = stripe_signature_header(payload, secret=STRIPE_WEBHOOK_SECRET, timestamp=timestamp)
    event = checkout_client.webhook_event_construct(payload=payload.encode(), signature=header)

    assert event.type == 'checkout.session.completed'
    assert event.data.object.id == 'cs_test_1'
    assert isinstance(event.data.object, stripe.checkout.Session)


def test_publishable_key_without_one_reports_payments_unavailable(settings: Settings) -> None:
    settings.STRIPE_PUBLISHABLE_KEY = ''
    message = re.escape(checkout_client.PAYMENTS_UNCONFIGURED_MESSAGE)

    assert not checkout_client.payments_configured()

    with pytest.raises(PaymentsUnavailableError, match=message):
        checkout_client.publishable_key()

    settings.STRIPE_PUBLISHABLE_KEY = STRIPE_PUBLISHABLE_KEY

    assert checkout_client.publishable_key() == STRIPE_PUBLISHABLE_KEY


def test_refund_retrieve_accepts_a_card_or_a_non_card_refund_and_refuses_anything_else(
    caplog: pytest.LogCaptureFixture,
    stripe_fake: StripeFake,
) -> None:
    stripe_fake.refund_add(
        amount=100,
        payment_intent='pi_test_1',
        refund_id='re_test_card',
        status='succeeded',
    )

    stripe_fake.refund_add(
        amount=100,
        payment_intent='pi_test_1',
        refund_id='pyr_test_bank',
        status='pending',
    )

    card = checkout_client.refund_retrieve('re_test_card')
    bank = checkout_client.refund_retrieve('pyr_test_bank')
    message_invalid = re.escape(checkout_client.REFUND_INVALID_MESSAGE)
    message_unknown = re.escape(checkout_client.REFUND_UNKNOWN_MESSAGE)

    assert card.id == 're_test_card'
    assert bank.id == 'pyr_test_bank'

    for refund_id in ('', 're_', 'pyr_', 'pi_test_1', 're_test 1', 're_' + 'a' * 251):
        with pytest.raises(PaymentUnknownError, match=message_invalid):
            checkout_client.refund_retrieve(refund_id)

    with pytest.raises(PaymentUnknownError, match=message_unknown):
        checkout_client.refund_retrieve('re_test_missing')

    assert 'Stripe refused refund re_test_missing: ' in caplog.text

    refund_id_longest = 're_' + 'a' * 250

    stripe_fake.refund_add(
        amount=100,
        payment_intent='pi_test_1',
        refund_id=refund_id_longest,
        status='succeeded',
    )

    longest = checkout_client.refund_retrieve(refund_id_longest)

    assert longest.id == refund_id_longest


def test_refund_retrieve_that_returns_another_refund_is_a_programming_error(
    monkeypatch: pytest.MonkeyPatch,
    stripe_fake: StripeFake,
) -> None:
    other = stripe_fake.refund_add(
        amount=100,
        payment_intent='pi_test_1',
        refund_id='re_test_other',
        status='succeeded',
    )

    refund = checkout_client.refund_retrieve(other.id)

    assert refund == other

    monkeypatch.setattr(stripe_fake, 'refund_retrieve', lambda _: other)

    with pytest.raises(RuntimeError, match='returned refund re_test_other for re_test_1'):
        checkout_client.refund_retrieve('re_test_1')


def test_refund_retrieve_reports_an_unreachable_stripe_as_unavailable(
    caplog: pytest.LogCaptureFixture,
    stripe_fake: StripeFake,
) -> None:
    stripe_fake.retrieve_error = stripe.APIConnectionError('Network down')
    message = 'Stripe could not confirm the refund yet. Try again in a minute.'

    with pytest.raises(PaymentsUnavailableError, match=re.escape(message)):
        checkout_client.refund_retrieve('re_test_1')

    assert 'Stripe could not return refund re_test_1' in caplog.text
    assert [record.levelno for record in caplog.records] == [logging.ERROR]


def test_session_by_payment_intent_finds_the_session_that_took_it_or_none(
    stripe_fake: StripeFake,
) -> None:
    metadata = {'app': 'remi'}

    stripe_fake.session_add(
        amount_total=1000,
        metadata=metadata,
        payment_status='paid',
        session_id='cs_test_paid',
    )

    stripe_fake.session_add(
        amount_total=1000,
        metadata=metadata,
        payment_status='unpaid',
        session_id='cs_test_open',
    )

    found = checkout_client.checkout_session_by_payment_intent('pi_test_paid')
    missing = checkout_client.checkout_session_by_payment_intent('pi_test_open')

    assert found is not None
    assert found.id == 'cs_test_paid'
    assert missing is None

    for payment_intent_id in ('', 'pi_', 'cs_test_paid', 'pi_test 1', 'pi_' + 'a' * 251):
        with pytest.raises(ValueError, match='payment_intent_id must name a payment intent'):
            checkout_client.checkout_session_by_payment_intent(payment_intent_id)

    missing_longest = checkout_client.checkout_session_by_payment_intent('pi_' + 'a' * 250)

    assert missing_longest is None


def test_session_by_payment_intent_that_returns_another_intent_is_a_programming_error(
    monkeypatch: pytest.MonkeyPatch,
    stripe_fake: StripeFake,
) -> None:
    metadata = {'app': 'remi'}
    parameters = SessionListParams(payment_intent='pi_test_other')

    stripe_fake.session_add(
        amount_total=1000,
        metadata=metadata,
        payment_status='paid',
        session_id='cs_test_other',
    )

    listed = stripe_fake.list(parameters)
    found = checkout_client.checkout_session_by_payment_intent('pi_test_other')

    assert found is not None
    assert found.id == 'cs_test_other'
    assert [session.payment_intent for session in listed.data] == ['pi_test_other']

    monkeypatch.setattr(stripe_fake, 'list', lambda _: listed)

    with pytest.raises(RuntimeError, match='returned checkout session cs_test_other for pi_test_1'):
        checkout_client.checkout_session_by_payment_intent('pi_test_1')


def test_session_by_payment_intent_reports_an_unreachable_stripe_as_unavailable(
    caplog: pytest.LogCaptureFixture,
    stripe_fake: StripeFake,
) -> None:
    stripe_fake.retrieve_error = stripe.APIConnectionError('Network down')
    message = 'Stripe could not confirm the payment yet. Try again in a minute.'

    with pytest.raises(PaymentsUnavailableError, match=re.escape(message)):
        checkout_client.checkout_session_by_payment_intent('pi_test_1')

    assert 'Stripe could not list the checkout sessions of pi_test_1' in caplog.text
    assert [record.levelno for record in caplog.records] == [logging.ERROR]
