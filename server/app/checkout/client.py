from __future__ import annotations

import functools
import logging
import re

import stripe

from typing_extensions import TYPE_CHECKING

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

from app.core.exceptions import (
    CheckoutUnknownError,
    PaymentsUnavailableError,
    RequestInvalidError,
)
from system.environment import STRIPE_PUBLISHABLE_KEY_PATTERN

if TYPE_CHECKING:
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
PAYMENTS_UNCONFIGURED_MESSAGE = 'Payments are not set up on this server yet.'
STRIPE_NETWORK_RETRIES_MAX = 2
WEBHOOK_PAYLOAD_MISSING_MESSAGE = 'The webhook carries no payload.'
WEBHOOK_SIGNATURE_MISSING_MESSAGE = 'The webhook carries no Stripe-Signature header.'


@functools.lru_cache(maxsize=1)
def _stripe_client_shared(secret_key: str) -> stripe.StripeClient:
    if secret_key == '':
        message = 'a Stripe client needs a secret key'
        raise ValueError(message)

    return stripe.StripeClient(
        secret_key,
        max_network_retries=STRIPE_NETWORK_RETRIES_MAX,
    )


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
    metadata = {} if session.metadata is None else session.metadata.to_dict()

    return metadata.get('app') == CHECKOUT_METADATA_APP


def checkout_session_retrieve(session_id: str) -> stripe.checkout.Session:
    if CHECKOUT_SESSION_PATTERN.fullmatch(session_id) is None:
        raise CheckoutUnknownError(CHECKOUT_SESSION_INVALID_MESSAGE)

    try:
        session = stripe_client().v1.checkout.sessions.retrieve(session_id)
    except stripe.InvalidRequestError:
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


def stripe_client() -> stripe.StripeClient:
    if settings.STRIPE_SECRET_KEY == '':
        raise PaymentsUnavailableError(PAYMENTS_UNCONFIGURED_MESSAGE)

    return _stripe_client_shared(settings.STRIPE_SECRET_KEY)


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
