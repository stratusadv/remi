from __future__ import annotations

import hashlib
import hmac
import json

import stripe

from types import SimpleNamespace
from typing_extensions import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Mapping

    from stripe.params.checkout import SessionCreateParams, SessionListParams


STRIPE_CURRENCY = 'cad'
STRIPE_PUBLISHABLE_KEY = 'pk_test_remi'
STRIPE_SECRET_KEY = 'sk_test_remi'
STRIPE_WEBHOOK_SECRET = 'whsec_remi'


def _payment_intent_for(
    session_id: str,
    *,
    amount_total: int | None,
    payment_status: str,
) -> str | None:
    if not isinstance(session_id, str):
        message = f'session_id must be a str, not {type(session_id).__name__}'
        raise TypeError(message)

    if not isinstance(amount_total, int | None):
        message = f'amount_total must be an int or None, not {type(amount_total).__name__}'
        raise TypeError(message)

    if not isinstance(payment_status, str):
        message = f'payment_status must be a str, not {type(payment_status).__name__}'
        raise TypeError(message)

    if payment_status != 'paid':
        return None

    if amount_total == 0:
        return None

    return session_id.replace('cs_', 'pi_', 1)


class StripeFake:
    def __init__(self) -> None:
        self.create_error = None
        self.created = []
        self.refunds = {}
        self.retrieve_error = None
        self.sessions = {}

    def client(self) -> SimpleNamespace:
        checkout = SimpleNamespace(sessions=self)
        refunds = SimpleNamespace(retrieve=self.refund_retrieve)
        version = SimpleNamespace(checkout=checkout, refunds=refunds)

        return SimpleNamespace(v1=version)

    def create(self, parameters: SessionCreateParams) -> stripe.checkout.Session:
        if self.create_error is not None:
            raise self.create_error

        if parameters.get('mode') != 'payment':
            message = f'the Stripe fake creates payment sessions only: {parameters.get("mode")!r}'
            raise ValueError(message)

        self.created.append(parameters)

        session_id = f'cs_test_{len(self.created)}'
        line_items = parameters.get('line_items', [])

        amount_total = sum(
            item['price_data']['unit_amount'] * item['quantity']
            for item in line_items
        )

        return self.session_add(
            amount_total=amount_total,
            client_reference_id=parameters.get('client_reference_id', ''),
            metadata=parameters.get('metadata', {}),
            payment_status='unpaid',
            session_id=session_id,
        )

    def list(self, parameters: SessionListParams) -> stripe.ListObject[stripe.checkout.Session]:
        if self.retrieve_error is not None:
            raise self.retrieve_error

        if 'payment_intent' not in parameters:
            message = 'the Stripe fake lists checkout sessions by payment intent only'
            raise ValueError(message)

        payment_intent = parameters.get('payment_intent')

        sessions = [
            session.to_dict()
            for session in self.sessions.values()
            if session.payment_intent == payment_intent
        ]

        values = {
            'data': sessions,
            'has_more': False,
            'object': 'list',
            'url': '/v1/checkout/sessions',
        }

        return stripe.ListObject.construct_from(values, STRIPE_SECRET_KEY)

    def pay(self, session_id: str) -> None:
        if session_id not in self.sessions:
            message = f'session_id names no session the Stripe fake holds: {session_id!r}'
            raise ValueError(message)

        session = self.sessions[session_id]

        session.payment_intent = _payment_intent_for(
            session_id,
            amount_total=session.amount_total,
            payment_status='paid',
        )

        session.payment_status = 'paid'

    def refund_add(
        self,
        *,
        amount: int,
        currency: str = STRIPE_CURRENCY,
        payment_intent: str | None,
        refund_id: str,
        status: str,
    ) -> stripe.Refund:
        if not isinstance(amount, int):
            message = f'amount must be an int, not {type(amount).__name__}'
            raise TypeError(message)

        if not isinstance(currency, str):
            message = f'currency must be a str, not {type(currency).__name__}'
            raise TypeError(message)

        if not isinstance(payment_intent, str | None):
            message = f'payment_intent must be a str or None, not {type(payment_intent).__name__}'
            raise TypeError(message)

        if not isinstance(refund_id, str):
            message = f'refund_id must be a str, not {type(refund_id).__name__}'
            raise TypeError(message)

        if not isinstance(status, str):
            message = f'status must be a str, not {type(status).__name__}'
            raise TypeError(message)

        values = {
            'amount': amount,
            'currency': currency,
            'id': refund_id,
            'object': 'refund',
            'payment_intent': payment_intent,
            'status': status,
        }

        refund = stripe.Refund.construct_from(values, STRIPE_SECRET_KEY)
        self.refunds[refund_id] = refund

        return refund

    def refund_retrieve(self, refund_id: str) -> stripe.Refund:
        if self.retrieve_error is not None:
            raise self.retrieve_error

        if refund_id not in self.refunds:
            message = f'No such refund: {refund_id}'
            raise stripe.InvalidRequestError(message, 'id')

        return self.refunds[refund_id]

    def retrieve(self, session_id: str) -> stripe.checkout.Session:
        if self.retrieve_error is not None:
            raise self.retrieve_error

        if session_id not in self.sessions:
            message = f'No such checkout.session: {session_id}'
            raise stripe.InvalidRequestError(message, 'session')

        return self.sessions[session_id]

    def session_add(
        self,
        *,
        amount_total: int | None = None,
        client_reference_id: str = '',
        currency: str = STRIPE_CURRENCY,
        metadata: object,
        payment_status: str,
        session_id: str,
    ) -> stripe.checkout.Session:
        if not isinstance(amount_total, int | None):
            message = f'amount_total must be an int or None, not {type(amount_total).__name__}'
            raise TypeError(message)

        if not isinstance(client_reference_id, str):
            message = f'client_reference_id must be a str, not {type(client_reference_id).__name__}'
            raise TypeError(message)

        if not isinstance(currency, str):
            message = f'currency must be a str, not {type(currency).__name__}'
            raise TypeError(message)

        if not isinstance(metadata, dict):
            message = f'metadata must be a dict, not {type(metadata).__name__}'
            raise TypeError(message)

        if not isinstance(payment_status, str):
            message = f'payment_status must be a str, not {type(payment_status).__name__}'
            raise TypeError(message)

        if not isinstance(session_id, str):
            message = f'session_id must be a str, not {type(session_id).__name__}'
            raise TypeError(message)

        payment_intent = _payment_intent_for(
            session_id,
            amount_total=amount_total,
            payment_status=payment_status,
        )

        values = {
            'amount_total': amount_total,
            'client_reference_id': client_reference_id,
            'client_secret': f'{session_id}_secret_remi',
            'currency': currency,
            'id': session_id,
            'metadata': metadata,
            'object': 'checkout.session',
            'payment_intent': payment_intent,
            'payment_status': payment_status,
            'ui_mode': 'elements',
        }

        session = stripe.checkout.Session.construct_from(values, STRIPE_SECRET_KEY)
        self.sessions[session_id] = session

        return session


def stripe_event_encode(*, event_object: Mapping[str, object], event_type: str) -> str:
    if not isinstance(event_object, dict):
        message = f'event_object must be a dict, not {type(event_object).__name__}'
        raise TypeError(message)

    if not isinstance(event_type, str):
        message = f'event_type must be a str, not {type(event_type).__name__}'
        raise TypeError(message)

    event = {
        'data': {'object': event_object},
        'id': 'evt_test_1',
        'object': 'event',
        'type': event_type,
    }

    return json.dumps(event)


def stripe_event_payload(*, event_type: str, session_id: str) -> str:
    if not isinstance(event_type, str):
        message = f'event_type must be a str, not {type(event_type).__name__}'
        raise TypeError(message)

    if not isinstance(session_id, str):
        message = f'session_id must be a str, not {type(session_id).__name__}'
        raise TypeError(message)

    session = {'id': session_id, 'object': 'checkout.session'}
    return stripe_event_encode(event_object=session, event_type=event_type)


def stripe_signature_header(payload: str, *, secret: str, timestamp: int) -> str:
    if not isinstance(payload, str):
        message = f'payload must be a str, not {type(payload).__name__}'
        raise TypeError(message)

    if not secret.startswith('whsec_'):
        message = 'secret must be a Stripe webhook signing secret'
        raise ValueError(message)

    if timestamp <= 0:
        message = f'timestamp must be positive: {timestamp}'
        raise ValueError(message)

    signed = f'{timestamp}.{payload}'.encode()
    digest = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()

    return f't={timestamp},v1={digest}'
