from __future__ import annotations

from app.account.ledger.choices import AccountLedgerEntryKindChoices
from app.account.ledger.models import AccountLedgerEntry
from app.account.models import Account
from app.promo_code.tests.factories import create_test_promo_code


def create_test_account(*, email: str = 'avery@example.com', seconds: int = 0) -> Account:
    assert '@' in email
    assert seconds >= 0

    account, _ = Account.services.factory.create(
        email=email,
        name='Avery',
        promo_code='',
        region='CA-AB',
    )

    if seconds > 0:
        promo_code = create_test_promo_code(code=f'SEED{account.pk}', hours=1)

        AccountLedgerEntry.objects.create(
            account=account,
            kind=AccountLedgerEntryKindChoices.PROMO,
            promo_code=promo_code,
            reference=promo_code.code,
            seconds=seconds,
        )

    return account
