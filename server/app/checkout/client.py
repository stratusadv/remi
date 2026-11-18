from __future__ import annotations

import functools
import logging
import re

import stripe

from typing_extensions import TYPE_CHECKING, cast

from stripe.params.checkout import SessionListParams

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

from app.core.exceptions import (
    CheckoutUnknownError,
    PaymentsUnavailableError,
    PaymentUnknownError,
    RequestInvalidError,
)
from system.environment import STRIPE_PUBLISHABLE_KEY_PATTERN

if TYPE_CHECKING:
    from stripe._base_address import BaseAddresses
    from stripe.params.checkout import SessionCreateParams


logger = logging.getLogger(__name__)

CHECKOUT_EVENT_TYPES = ('checkout.session.async_payment_succeeded', 'checkout.session.completed')
CHECKOUT_METADATA_APP = 'remi'
CHECKOUT_MODE = 'payment'
CHECKOUT_PAYMENT_METHOD_TYPES_ALLOWED = ('card',)
CHECKOUT_RETURN_URL_SCHEMES = ('http://', 'https://')
CHECKOUT_SESSION_INVALID_MESSAGE = 'That is not a Stripe checkout session.'
CHECKOUT_SESSION_PATTERN = re.compile(r'cs_[A-Za-z0-9_]{1,250}')
CHECKOUT_SESSION_UNKNOWN_MESSAGE = 'Stripe has no checkout session with that id.'
CHECKOUT_UI_MODE = 'elements'
DISPUTE_CLOSED_EVENT_TYPE = 'charge.dispute.closed'
DISPUTE_PATTERN = re.compile(r'(?:dp|du)_[A-Za-z0-9_]{1,250}')
DISPUTE_STATUS_LOST = 'lost'
PAYMENT_INTENT_PATTERN = re.compile(r'pi_[A-Za-z0-9_]{1,250}')
PAYMENTS_UNCONFIGURED_MESSAGE = 'Payments are not set up on this server yet.'
REFUND_EVENT_TYPES = ('refund.created', 'refund.failed', 'refund.updated')
REFUND_INVALID_MESSAGE = 'That is not a Stripe refund.'
REFUND_PATTERN = re.compile(r'(?:pyr|re)_[A-Za-z0-9_]{1,250}')
REFUND_STATUSES_STANDING = ('pending', 'requires_action', 'succeeded')
REFUND_STATUSES_UNDONE = ('canceled', 'failed')
REFUND_UNKNOWN_MESSAGE = 'Stripe has no refund with that id.'
STRIPE_NETWORK_RETRIES_MAX = 2
WEBHOOK_PAYLOAD_MISSING_MESSAGE = 'The webhook carries no payload.'
WEBHOOK_SIGNATURE_MISSING_MESSAGE = 'The webhook carries no Stripe-Signature header.'


@functools.lru_cache(maxsize=1)
def _stripe_client_shared(*, api_base: str, secret_key: str) -> stripe.StripeClient:
    if secret_key == '':
        message = 'a Stripe client needs a secret key'
        raise ValueError(message)

    if api_base != '':
        if not api_base.startswith(CHECKOUT_RETURN_URL_SCHEMES):
            message = f'the Stripe API base must be an http or https address: {api_base!r}'
            raise ValueError(message)

    addresses = {} if api_base == '' else {'api': api_base}
    base_addresses = cast('BaseAddresses', addresses)

    return stripe.StripeClient(
        secret_key,
        base_addresses=base_addresses,
        max_network_retries=STRIPE_NETWORK_RETRIES_MAX,
    )


def checkout_session_by_payment_intent(payment_intent_id: str) -> stripe.checkout.Session | None:
    if PAYMENT_INTENT_PATTERN.fullmatch(payment_intent_id) is None:
        message = f'payment_intent_id must name a payment intent: {payment_intent_id!r}'
        raise ValueError(message)

    try:
        parameters = SessionListParams(limit=1, payment_intent=payment_intent_id)
        sessions = stripe_client().v1.checkout.sessions.list(parameters)
    except stripe.StripeError:
        logger.exception('Stripe could not list the checkout sessions of %s', payment_intent_id)
        message = 'Stripe could not confirm the payment yet. Try again in a minute.'
        raise PaymentsUnavailableError(message) from None

    if len(sessions.data) == 0:
        return None

    session = sessions.data[0]

    if session.payment_intent != payment_intent_id:
        message = f'Stripe returned checkout session {session.id} for {payment_intent_id}'
        raise RuntimeError(message)

    return session


def checkout_session_create(parameters: SessionCreateParams) -> stripe.checkout.Session:
    if parameters.get('mode') != CHECKOUT_MODE:
        message = f'a checkout session is a one-time payment: {parameters.get("mode")!r}'
        raise ValueError(message)

    if parameters.get('ui_mode') != CHECKOUT_UI_MODE:
        message = f'a checkout session is paid inside remi: {parameters.get("ui_mode")!r}'
        raise ValueError(message)

    account_id = parameters.get('client_reference_id', '')

    if account_id == '':
        message = 'a checkout session names the account it is started for'
        raise ValueError(message)

    return_url = parameters.get('return_url', '')

    if not return_url.startswith(CHECKOUT_RETURN_URL_SCHEMES):
        message = f'Stripe.js confirms a session only with an absolute return_url: {return_url!r}'
        raise ValueError(message)

    if not payments_configured():
        raise PaymentsUnavailableError(PAYMENTS_UNCONFIGURED_MESSAGE)

    try:
        session = stripe_client().v1.checkout.sessions.create(parameters)
    except stripe.StripeError:
        logger.exception('Stripe refused a checkout session for account %s', account_id)
        message = 'Stripe could not start the checkout. Try again in a minute.'
        raise PaymentsUnavailableError(message) from None

    if CHECKOUT_SESSION_PATTERN.fullmatch(session.id) is None:
        message = f'Stripe returned a checkout session with the id {session.id!r}'
        raise RuntimeError(message)

    if not session.client_secret:
        message = 'Stripe returned a checkout session without a client secret.'
        raise PaymentsUnavailableError(message)

    return session


def checkout_session_owned(session: stripe.checkout.Session) -> bool:
    if CHECKOUT_SESSION_PATTERN.fullmatch(session.id) is None:
        message = f'session must be a checkout session: {session.id!r}'
        raise ValueError(message)

    metadata = {} if session.metadata is None else session.metadata.to_dict()
    return metadata.get('app') == CHECKOUT_METADATA_APP


def checkout_session_retrieve(session_id: str) -> stripe.checkout.Session:
    if CHECKOUT_SESSION_PATTERN.fullmatch(session_id) is None:
        raise CheckoutUnknownError(CHECKOUT_SESSION_INVALID_MESSAGE)

    try:
        session = stripe_client().v1.checkout.sessions.retrieve(session_id)
    except stripe.InvalidRequestError as error:
        logger.warning('Stripe refused checkout session %s: %s', session_id, error)

        raise CheckoutUnknownError(CHECKOUT_SESSION_UNKNOWN_MESSAGE) from None
    except stripe.StripeError:
        logger.exception('Stripe could not return checkout session %s', session_id)
        message = 'Stripe could not confirm the payment yet. Try again in a minute.'
        raise PaymentsUnavailableError(message) from None

    if session.id != session_id:
        message = f'Stripe returned checkout session {session.id} for {session_id}'
        raise RuntimeError(message)

    return session


def payments_configured() -> bool:
    return settings.STRIPE_PUBLISHABLE_KEY != '' and settings.STRIPE_SECRET_KEY != ''


def publishable_key() -> str:
    key = settings.STRIPE_PUBLISHABLE_KEY

    if key == '':
        raise PaymentsUnavailableError(PAYMENTS_UNCONFIGURED_MESSAGE)

    if STRIPE_PUBLISHABLE_KEY_PATTERN.fullmatch(key) is None:
        message = 'STRIPE_PUBLISHABLE_KEY holds something other than a Stripe publishable key'
        raise ImproperlyConfigured(message)

    return key


def refund_retrieve(refund_id: str) -> stripe.Refund:
    if REFUND_PATTERN.fullmatch(refund_id) is None:
        raise PaymentUnknownError(REFUND_INVALID_MESSAGE)

    try:
        refund = stripe_client().v1.refunds.retrieve(refund_id)
    except stripe.InvalidRequestError as error:
        logger.warning('Stripe refused refund %s: %s', refund_id, error)

        raise PaymentUnknownError(REFUND_UNKNOWN_MESSAGE) from None
    except stripe.StripeError:
        logger.exception('Stripe could not return refund %s', refund_id)
        message = 'Stripe could not confirm the refund yet. Try again in a minute.'
        raise PaymentsUnavailableError(message) from None

    if refund.id != refund_id:
        message = f'Stripe returned refund {refund.id} for {refund_id}'
        raise RuntimeError(message)

    return refund


def stripe_client() -> stripe.StripeClient:
    if settings.STRIPE_SECRET_KEY == '':
        raise PaymentsUnavailableError(PAYMENTS_UNCONFIGURED_MESSAGE)

    return _stripe_client_shared(
        api_base=settings.STRIPE_API_BASE,
        secret_key=settings.STRIPE_SECRET_KEY,
    )


def webhook_event_construct(*, payload: bytes, signature: str) -> stripe.Event:
    if settings.STRIPE_WEBHOOK_SECRET == '':
        raise PaymentsUnavailableError(PAYMENTS_UNCONFIGURED_MESSAGE)

    if payload == b'':
        raise RequestInvalidError(WEBHOOK_PAYLOAD_MISSING_MESSAGE)

    if signature == '':
        raise RequestInvalidError(WEBHOOK_SIGNATURE_MISSING_MESSAGE)

    try:
        event = stripe.Webhook.construct_event(payload, signature, settings.STRIPE_WEBHOOK_SECRET)
    except (stripe.SignatureVerificationError, ValueError):
        message = 'The webhook signature or payload is invalid.'
        raise RequestInvalidError(message) from None

    return event
