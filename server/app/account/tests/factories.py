from __future__ import annotations

from app.account.ledger.choices import AccountLedgerEntryKindChoices
from app.account.ledger.models import AccountLedgerEntry
from app.account.models import Account


def create_test_account(*, email: str = 'avery@example.com', seconds: int = 0) -> Account:
    account, _ = Account.services.factory.create(email=email, name='Avery', promo_code='')

    if seconds > 0:
        AccountLedgerEntry.objects.create(
            account=account,
            kind=AccountLedgerEntryKindChoices.PROMO,
            reference='SEED',
            seconds=seconds,
        )

    return account
