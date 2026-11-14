from __future__ import annotations

from typing_extensions import TYPE_CHECKING, Self

from django.db.models import Sum
from django.db.models.functions import Coalesce

from app.account.constants import ACCOUNT_TOKEN_HASH_LENGTH
from app.core.querysets import BaseQuerySet

if TYPE_CHECKING:
    from app.account.models import Account


class AccountQuerySet(BaseQuerySet['Account']):
    def by_token_hash(self, token_hash: str) -> Self:
        if len(token_hash) != ACCOUNT_TOKEN_HASH_LENGTH:
            message = (
                f'token_hash must be {ACCOUNT_TOKEN_HASH_LENGTH} characters, '
                f'not {len(token_hash)}'
            )

            raise ValueError(message)

        return self.filter(token_hash=token_hash)

    def complimentary(self) -> Self:
        return self.filter(is_complimentary=True)

    def with_balance(self) -> Self:
        return self.annotate(balance_seconds=Coalesce(Sum('ledger_entry__seconds'), 0))
