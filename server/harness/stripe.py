from __future__ import annotations

import hashlib
import hmac
import json

import stripe

from types import SimpleNamespace
from typing_extensions import TYPE_CHECKING

if TYPE_CHECKING:
    from stripe.params.checkout import SessionCreateParams


STRIPE_PUBLISHABLE_KEY = 'pk_test_remi'
STRIPE_SECRET_KEY = 'sk_test_remi'
STRIPE_WEBHOOK_SECRET = 'whsec_remi'


class StripeFake:
    def __init__(self) -> None:
        self.create_error = None
        self.created = []
        self.retrieve_error = None
        self.sessions = {}

    def client(self) -> SimpleNamespace:
        checkout = SimpleNamespace(sessions=self)
        version = SimpleNamespace(checkout=checkout)

        return SimpleNamespace(v1=version)

    def create(self, parameters: SessionCreateParams) -> stripe.checkout.Session:
        if self.create_error is not None:
            raise self.create_error

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

    def pay(self, session_id: str) -> None:
        self.sessions[session_id].payment_status = 'paid'

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
        metadata: object,
        payment_status: str,
        session_id: str,
    ) -> stripe.checkout.Session:
        values = {
            'amount_total': amount_total,
            'client_reference_id': client_reference_id,
            'client_secret': f'{session_id}_secret_remi',
            'id': session_id,
            'metadata': metadata,
            'object': 'checkout.session',
            'payment_status': payment_status,
            'ui_mode': 'elements',
        }

        session = stripe.checkout.Session.construct_from(values, STRIPE_SECRET_KEY)
        self.sessions[session_id] = session

        return session


def stripe_event_payload(*, event_type: str, session_id: str) -> str:
    session = {'id': session_id, 'object': 'checkout.session'}

    event = {
        'data': {'object': session},
        'id': 'evt_test_1',
        'object': 'event',
        'type': event_type,
    }

    return json.dumps(event)


def stripe_signature_header(payload: str, *, secret: str, timestamp: int) -> str:
    signed = f'{timestamp}.{payload}'.encode()
    digest = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()

    return f't={timestamp},v1={digest}'
