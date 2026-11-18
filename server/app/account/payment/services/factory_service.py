from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.db import transaction

from django_spire.contrib.constructor.service import BaseDjangoModelService

from app.checkout import client
from system.environment import CURRENCY_PATTERN

if TYPE_CHECKING:
    from app.account.models import Account
    from app.account.payment.models import AccountPayment


class AccountPaymentFactoryService(BaseDjangoModelService['AccountPayment']):
    obj: AccountPayment

    def create(
        self,
        *,
        account: Account,
        amount_cents: int | None,
        currency: str,
        payment_intent_id: str | None,
        seconds: int,
        session_id: str,
    ) -> AccountPayment:
        if account.pk is None:
            message = f'account must be saved: {account!r}'
            raise ValueError(message)

        if amount_cents is not None:
            if amount_cents < 0:
                message = f'amount_cents must not be negative: {amount_cents}'
                raise ValueError(message)

        if CURRENCY_PATTERN.fullmatch(currency) is None:
            message = f'currency must be a lowercase three-letter code: {currency!r}'
            raise ValueError(message)

        if payment_intent_id is not None:
            if client.PAYMENT_INTENT_PATTERN.fullmatch(payment_intent_id) is None:
                message = f'payment_intent_id must name a payment intent: {payment_intent_id!r}'
                raise ValueError(message)

        if seconds <= 0:
            message = f'seconds must be positive: {seconds}'
            raise ValueError(message)

        if client.CHECKOUT_SESSION_PATTERN.fullmatch(session_id) is None:
            message = f'session_id must name a checkout session: {session_id!r}'
            raise ValueError(message)

        if not self.model_obj_is_new:
            message = f'a payment factory creates one payment, and already holds {self.obj!r}'
            raise RuntimeError(message)

        if not transaction.get_connection().in_atomic_block:
            message = 'a payment is written inside the transaction that locked its account'
            raise RuntimeError(message)

        self.obj.account = account
        self.obj.amount_cents = amount_cents
        self.obj.currency = currency
        self.obj.seconds = seconds
        self.obj.stripe_checkout_session_id = session_id
        self.obj.stripe_payment_intent_id = payment_intent_id

        _, created = self.save_model_obj()

        if not created:
            message = f'the payment {self.obj!r} was updated instead of created'
            raise RuntimeError(message)

        return self.obj
