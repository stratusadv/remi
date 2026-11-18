from __future__ import annotations

from typing_extensions import TYPE_CHECKING, Self

from django.db.models import QuerySet

from app.account.constants import STRIPE_ID_LENGTH_MAX

if TYPE_CHECKING:
    from app.account.payment.models import AccountPayment


class AccountPaymentQuerySet(QuerySet['AccountPayment']):
    def by_checkout_session(self, session_id: str) -> Self:
        if not 0 < len(session_id) <= STRIPE_ID_LENGTH_MAX:
            message = f'session_id must be 1 to {STRIPE_ID_LENGTH_MAX} characters: {session_id!r}'
            raise ValueError(message)

        return self.filter(stripe_checkout_session_id=session_id)

    def by_payment_intent(self, payment_intent_id: str) -> Self:
        if not 0 < len(payment_intent_id) <= STRIPE_ID_LENGTH_MAX:
            message = (
                f'payment_intent_id must be 1 to {STRIPE_ID_LENGTH_MAX} characters: '
                f'{payment_intent_id!r}'
            )

            raise ValueError(message)

        return self.filter(stripe_payment_intent_id=payment_intent_id)
