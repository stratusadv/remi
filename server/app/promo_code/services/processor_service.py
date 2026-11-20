from __future__ import annotations

import secrets

from typing_extensions import TYPE_CHECKING

from django.db import IntegrityError, transaction
from django.utils import timezone

from django_spire.contrib.constructor.service import BaseDjangoModelService

from app.account.constants import ACCOUNT_EMAIL_LENGTH_MAX, ACCOUNT_NAME_LENGTH_MAX
from app.account.ledger.models import AccountLedgerEntry
from app.core.exceptions import PromoInvalidError
from app.funnel.choices import CampaignChoices
from app.funnel.metric import funnel_lead_record, funnel_redemption_record
from app.promo_code.constants import (
    PROMO_CODE_INVALID_MESSAGE,
    PROMO_CODE_ISSUE_ALPHABET,
    PROMO_CODE_ISSUE_ATTEMPTS_MAX,
    PROMO_CODE_ISSUE_GROUP_COUNT,
    PROMO_CODE_ISSUE_GROUP_LENGTH,
    PROMO_CODE_LENGTH_MAX,
)

if TYPE_CHECKING:
    from app.account.models import Account
    from app.promo_code.models import PromoCode


def _code_issue_text(campaign: str) -> str:
    if campaign not in CampaignChoices.values:
        message = f'campaign must be one of {CampaignChoices.values}: {campaign!r}'
        raise ValueError(message)

    length = PROMO_CODE_ISSUE_GROUP_COUNT * PROMO_CODE_ISSUE_GROUP_LENGTH
    characters = ''.join(secrets.choice(PROMO_CODE_ISSUE_ALPHABET) for _ in range(length))

    groups = [
        characters[start:start + PROMO_CODE_ISSUE_GROUP_LENGTH]
        for start in range(0, length, PROMO_CODE_ISSUE_GROUP_LENGTH)
    ]

    code = '-'.join([campaign.upper(), *groups])

    if not 0 < len(code) <= PROMO_CODE_LENGTH_MAX:
        message = f'an issued promo code has {len(code)} characters: {code!r}'
        raise RuntimeError(message)

    return code


class PromoCodeProcessorService(BaseDjangoModelService['PromoCode']):
    obj: PromoCode

    def _issue_create(
        self,
        *,
        code: str,
        email: str,
        name_first: str = '',
        name_last: str = '',
    ) -> PromoCode:
        if not 0 < len(code) <= PROMO_CODE_LENGTH_MAX:
            message = f'code must be 1 to {PROMO_CODE_LENGTH_MAX} characters: {code!r}'
            raise ValueError(message)

        if email == '':
            message = 'a personal promo code is issued to an email address'
            raise ValueError(message)

        if len(name_first) > ACCOUNT_NAME_LENGTH_MAX:
            message = (
                f'name_first has at most {ACCOUNT_NAME_LENGTH_MAX} characters: '
                f'{len(name_first)}'
            )

            raise ValueError(message)

        if len(name_last) > ACCOUNT_NAME_LENGTH_MAX:
            message = (
                f'name_last has at most {ACCOUNT_NAME_LENGTH_MAX} characters: '
                f'{len(name_last)}'
            )

            raise ValueError(message)

        personal = self.obj_class()
        personal.code = code
        personal.email = email
        personal.name_first = name_first
        personal.name_last = name_last
        personal.redemptions_max = 1

        with transaction.atomic():
            shared = self._promo_locked()
            personal.campaign = shared.campaign
            personal.hours = shared.hours

            if shared.early_codes_issued < shared.early_codes_max:
                personal.hours = shared.early_hours
                shared.early_codes_issued += 1

                shared.services.save_model_obj()

            if personal.hours <= 0:
                message = f'{shared.code} would issue a code worth {personal.hours} hours'
                raise RuntimeError(message)

            personal.services.save_model_obj()
            funnel_lead_record(campaign=personal.campaign)

        return personal

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

    def download_record(self) -> None:
        if self.obj.email == '':
            message = f'only a personal promo code records its download, not {self.obj.code}'
            raise ValueError(message)

        with transaction.atomic():
            promo = self._promo_locked()

            if promo.downloaded_datetime is None:
                promo.downloaded_datetime = timezone.now()

                promo.services.save_model_obj()

    def early_save(self, *, early_codes_max: int, early_hours: int) -> None:
        if self.obj.email != '':
            message = f'only a shared promo code has early terms, not {self.obj.code}'
            raise ValueError(message)

        if early_codes_max < 0:
            message = f'early_codes_max must be non-negative: {early_codes_max}'
            raise ValueError(message)

        if early_hours < 0:
            message = f'early_hours must be non-negative: {early_hours}'
            raise ValueError(message)

        if early_codes_max > 0:
            if early_hours == 0:
                message = f'early codes need early hours above zero: {early_codes_max} codes'
                raise ValueError(message)

        with transaction.atomic():
            promo = self._promo_locked()
            promo.early_codes_max = early_codes_max
            promo.early_hours = early_hours

            promo.services.save_model_obj()

    def issue(self, email: str, *, name_first: str = '', name_last: str = '') -> PromoCode:
        if self.obj.pk is None:
            message = f'the promo code must be saved: {self.obj!r}'
            raise ValueError(message)

        if self.obj.email != '':
            message = f'only a shared promo code issues personal codes, not {self.obj.code}'
            raise ValueError(message)

        if not 0 < len(email) <= ACCOUNT_EMAIL_LENGTH_MAX:
            message = f'email must be 1 to {ACCOUNT_EMAIL_LENGTH_MAX} characters: {email!r}'
            raise ValueError(message)

        if len(name_first) > ACCOUNT_NAME_LENGTH_MAX:
            message = (
                f'name_first has at most {ACCOUNT_NAME_LENGTH_MAX} characters: '
                f'{len(name_first)}'
            )

            raise ValueError(message)

        if len(name_last) > ACCOUNT_NAME_LENGTH_MAX:
            message = (
                f'name_last has at most {ACCOUNT_NAME_LENGTH_MAX} characters: '
                f'{len(name_last)}'
            )

            raise ValueError(message)

        issued = self.obj_class.objects.by_campaign(self.obj.campaign).by_email(email)

        for _ in range(PROMO_CODE_ISSUE_ATTEMPTS_MAX):
            existing = issued.first()

            if existing is not None:
                return existing

            try:
                code = _code_issue_text(self.obj.campaign)

                personal = self._issue_create(
                    code=code,
                    email=email,
                    name_first=name_first,
                    name_last=name_last,
                )
            except IntegrityError:
                continue
            else:
                return personal

        message = (
            f'no personal {self.obj.campaign} code was free in '
            f'{PROMO_CODE_ISSUE_ATTEMPTS_MAX} tries'
        )

        raise RuntimeError(message)

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

        redemptions = self.obj.redemptions.all()

        if redemptions.count() >= self.obj.redemptions_max:
            message = 'That promo code has been fully redeemed.'
            raise PromoInvalidError(message)

        if redemptions.by_email(account.email).exists():
            message = 'That promo code was already redeemed with this email address.'
            raise PromoInvalidError(message)

        if self.obj.campaign != CampaignChoices.GENERAL:
            promos = AccountLedgerEntry.objects.promos()
            redemptions_campaign = promos.by_campaign(self.obj.campaign)

            if redemptions_campaign.by_email(account.email).exists():
                label = self.obj.get_campaign_display()
                message = f'This email address already redeemed the {label} offer.'
                raise PromoInvalidError(message)

        if account.campaign == CampaignChoices.GENERAL:
            account.campaign = self.obj.campaign
            account.services.save_model_obj()

        AccountLedgerEntry.services.factory.promo_create(account=account, promo=self.obj)
        funnel_redemption_record(campaign=self.obj.campaign)

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
