from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction

from django_spire.contrib.constructor.service import BaseDjangoModelService

from app.account.choices import RegionChoices
from app.account.constants import ACCOUNT_EMAIL_LENGTH_MAX, ACCOUNT_NAME_LENGTH_MAX
from app.account.tokens import token_generate, token_hash
from app.core.exceptions import PromoInvalidError, RequestInvalidError
from app.funnel.metric import funnel_signup_record
from app.promo_code.constants import PROMO_CODE_LENGTH_MAX, PROMO_CODE_LENGTH_MESSAGE

if TYPE_CHECKING:
    from app.account.models import Account


EMAIL_LENGTH_MESSAGE = f'Enter an email address of at most {ACCOUNT_EMAIL_LENGTH_MAX} characters.'
NAME_LENGTH_MESSAGE = f'Enter a name of 1 to {ACCOUNT_NAME_LENGTH_MAX} characters.'
REGIONS_SIGN_UP = frozenset(region for region in RegionChoices.values if region.startswith('CA-'))
REGION_UNKNOWN_MESSAGE = 'Choose your province or territory.'


def _email_validate(email: str) -> None:
    if len(email) > ACCOUNT_EMAIL_LENGTH_MAX:
        raise RequestInvalidError(EMAIL_LENGTH_MESSAGE)

    try:
        validate_email(email)
    except ValidationError:
        message = 'Enter a valid email address.'
        raise RequestInvalidError(message) from None


class AccountFactoryService(BaseDjangoModelService['Account']):
    obj: Account

    def create(
        self,
        *,
        email: str,
        name: str,
        promo_code: str,
        region: str,
    ) -> tuple[Account, str]:
        if len(email.strip()) > ACCOUNT_EMAIL_LENGTH_MAX:
            raise RequestInvalidError(EMAIL_LENGTH_MESSAGE)

        if not 0 < len(name.strip()) <= ACCOUNT_NAME_LENGTH_MAX:
            raise RequestInvalidError(NAME_LENGTH_MESSAGE)

        if region not in REGIONS_SIGN_UP:
            raise RequestInvalidError(REGION_UNKNOWN_MESSAGE)

        if len(promo_code.strip()) > PROMO_CODE_LENGTH_MAX:
            raise PromoInvalidError(PROMO_CODE_LENGTH_MESSAGE)

        email_clean = email.strip()

        _email_validate(email_clean)

        if not self.model_obj_is_new:
            message = f'an account factory creates one account, and already holds {self.obj!r}'
            raise RuntimeError(message)

        token = token_generate()

        self.obj.email = email_clean
        self.obj.name = name.strip()
        self.obj.region = region
        self.obj.token_hash = token_hash(token)

        with transaction.atomic():
            _, created = self.save_model_obj()

            if not created:
                message = f'the account {self.obj!r} was updated instead of created'
                raise RuntimeError(message)

            account = self.obj

            if promo_code.strip() != '':
                account = account.services.processor.promo_redeem(promo_code)

            funnel_signup_record(campaign=account.campaign)

        return account, token
