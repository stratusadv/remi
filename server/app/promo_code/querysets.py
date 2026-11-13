from __future__ import annotations

from typing_extensions import TYPE_CHECKING, Self

from django.db.models import Exists, OuterRef

from app.account.constants import ACCOUNT_EMAIL_LENGTH_MAX
from app.core.querysets import BaseQuerySet
from app.funnel.choices import CampaignChoices
from app.promo_code.constants import PROMO_CODE_LENGTH_MAX

if TYPE_CHECKING:
    from app.promo_code.models import PromoCode


class PromoCodeQuerySet(BaseQuerySet['PromoCode']):
    def by_campaign(self, campaign: str) -> Self:
        if campaign not in CampaignChoices.values:
            message = f'campaign must be one of {CampaignChoices.values}: {campaign!r}'
            raise ValueError(message)

        return self.filter(campaign=campaign)

    def by_code(self, code: str) -> Self:
        if not 0 < len(code) <= PROMO_CODE_LENGTH_MAX:
            message = f'code must be 1 to {PROMO_CODE_LENGTH_MAX} characters: {code!r}'
            raise ValueError(message)

        return self.filter(code__iexact=code)

    def by_email(self, email: str) -> Self:
        if not 0 < len(email) <= ACCOUNT_EMAIL_LENGTH_MAX:
            message = f'email must be 1 to {ACCOUNT_EMAIL_LENGTH_MAX} characters: {email!r}'
            raise ValueError(message)

        return self.filter(email__iexact=email)

    def downloaded(self) -> Self:
        return self.filter(downloaded_datetime__isnull=False)

    def issued(self) -> Self:
        return self.exclude(email='')

    def shared(self) -> Self:
        return self.filter(email='')

    def undownloaded(self) -> Self:
        return self.filter(downloaded_datetime__isnull=True)

    def unredeemed(self) -> Self:
        from app.account.ledger.models import AccountLedgerEntry

        redemptions = AccountLedgerEntry.objects.promos().filter(reference=OuterRef('code'))

        return self.exclude(Exists(redemptions))
