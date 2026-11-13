from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.db import transaction

from django_spire.contrib.constructor.service import BaseDjangoModelService

from app.account.ledger.models import AccountLedgerEntry
from app.core.exceptions import PromoInvalidError
from app.funnel.choices import CampaignChoices
from app.promo_code.constants import PROMO_CODE_INVALID_MESSAGE

if TYPE_CHECKING:
    from app.account.models import Account
    from app.promo_code.models import PromoCode


class PromoCodeProcessorService(BaseDjangoModelService['PromoCode']):
    obj: PromoCode

    def _promo_locked(self) -> PromoCode:
        if self.obj.pk is None:
            message = f'the promo code must be saved: {self.obj!r}'
            raise ValueError(message)

        if not transaction.get_connection().in_atomic_block:
            message = 'a promo code is locked inside the transaction that writes it'
            raise RuntimeError(message)

        return self.obj_class.objects.by_id(self.obj.pk).locked().get()

    def active_set(self, *, is_active: bool) -> None:
        with transaction.atomic():
            promo = self._promo_locked()

            if is_active:
                promo.set_active()
            else:
                promo.set_inactive()

    def redeem(self, account: Account) -> None:
        if account.pk is None:
            message = f'account must be saved: {account!r}'
            raise ValueError(message)

        if self.obj.pk is None:
            message = f'the promo code must be saved: {self.obj!r}'
            raise ValueError(message)

        if not transaction.get_connection().in_atomic_block:
            message = 'a promo code is redeemed inside the transaction that locked it'
            raise RuntimeError(message)

        if not self.obj.is_active:
            raise PromoInvalidError(PROMO_CODE_INVALID_MESSAGE)

        if self.obj.is_deleted:
            raise PromoInvalidError(PROMO_CODE_INVALID_MESSAGE)

        redemptions = AccountLedgerEntry.objects.promos().by_reference(self.obj.code)

        if redemptions.count() >= self.obj.redemptions_max:
            message = 'That promo code has been fully redeemed.'
            raise PromoInvalidError(message)

        if redemptions.by_email(account.email).exists():
            message = 'That promo code was already redeemed with this email address.'
            raise PromoInvalidError(message)

        if account.campaign == CampaignChoices.GENERAL:
            account.campaign = self.obj.campaign
            account.services.save_model_obj()

        AccountLedgerEntry.services.factory.promo_create(account=account, promo=self.obj)

    def terms_save(self, *, campaign: str, hours: int, redemptions_max: int) -> None:
        if campaign not in CampaignChoices.values:
            message = f'campaign must be one of {CampaignChoices.values}: {campaign!r}'
            raise ValueError(message)

        if hours <= 0:
            message = f'hours must be positive: {hours}'
            raise ValueError(message)

        if redemptions_max < 0:
            message = f'redemptions_max must be non-negative: {redemptions_max}'
            raise ValueError(message)

        with transaction.atomic():
            promo = self._promo_locked()
            promo.campaign = campaign
            promo.hours = hours
            promo.redemptions_max = redemptions_max
            promo.services.save_model_obj()
