from __future__ import annotations

from typing_extensions import TYPE_CHECKING, Self

from django.db.models import QuerySet, Sum
from django.db.models.functions import Coalesce

from app.account.ledger.choices import AccountLedgerEntryKindChoices

if TYPE_CHECKING:
    from app.account.ledger.models import AccountLedgerEntry


class AccountLedgerEntryQuerySet(QuerySet['AccountLedgerEntry']):
    def balance_seconds(self) -> int:
        totals = self.aggregate(total=Coalesce(Sum('seconds'), 0))
        balance = totals['total']

        if not isinstance(balance, int):
            message = f'the ledger sum must be an int: {type(balance).__name__}'
            raise TypeError(message)

        return balance

    def by_email(self, email: str) -> Self:
        if email == '':
            message = 'email must be non-empty'
            raise ValueError(message)

        return self.filter(account__email__iexact=email)

    def by_reference(self, reference: str) -> Self:
        if reference == '':
            message = 'reference must be non-empty'
            raise ValueError(message)

        return self.filter(reference=reference)

    def charges(self) -> Self:
        return self.filter(kind=AccountLedgerEntryKindChoices.CHARGE)

    def promos(self) -> Self:
        return self.filter(kind=AccountLedgerEntryKindChoices.PROMO)

    def purchases(self) -> Self:
        return self.filter(kind=AccountLedgerEntryKindChoices.PURCHASE)
