from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from app.account.constants import SECONDS_PER_HOUR
from app.account.payment.models import AccountPayment
from harness.stripe import STRIPE_CURRENCY

if TYPE_CHECKING:
    from app.account.models import Account


def create_test_payment(
    account: Account,
    *,
    amount_cents: int = 1000,
    seconds: int = SECONDS_PER_HOUR,
    session_id: str = 'cs_test_paid',
) -> AccountPayment:
    assert amount_cents >= 0
    assert seconds > 0
    assert session_id.startswith('cs_')

    return AccountPayment.objects.create(
        account=account,
        amount_cents=amount_cents,
        currency=STRIPE_CURRENCY,
        seconds=seconds,
        stripe_checkout_session_id=session_id,
        stripe_payment_intent_id=session_id.replace('cs_', 'pi_', 1),
    )
