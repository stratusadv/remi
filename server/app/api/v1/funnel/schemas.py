from __future__ import annotations

import re

from ninja import Schema
from pydantic import field_validator

from app.account.constants import ACCOUNT_NAME_LENGTH_MAX
from app.funnel.choices import (
    CampaignChoices,
    FunnelPlatformChoices,
    FunnelSourceChoices,
)
from app.funnel.mail import funnel_email_address_clean
from app.promo_code.constants import PROMO_CODE_LENGTH_MAX


FUNNEL_CODE_PATTERN = re.compile(rf'[A-Za-z0-9-]{{0,{PROMO_CODE_LENGTH_MAX}}}')


class FunnelDownloadSchema(Schema):
    campaign: CampaignChoices
    code: str = ''
    platform: FunnelPlatformChoices

    @field_validator('code')
    @classmethod
    def code_clean(cls, value: str) -> str:
        if not isinstance(value, str):
            message = f'code must be a str: {type(value).__name__}'
            raise TypeError(message)

        code = value.strip()

        if FUNNEL_CODE_PATTERN.fullmatch(code) is None:
            message = 'the code is not a promo code'
            raise ValueError(message)

        return code


class FunnelEmailSchema(Schema):
    campaign: CampaignChoices
    email: str
    name_first: str = ''
    name_last: str = ''

    @field_validator('email')
    @classmethod
    def email_clean(cls, value: str) -> str:
        if not isinstance(value, str):
            message = f'email must be a str: {type(value).__name__}'
            raise TypeError(message)

        return funnel_email_address_clean(value)

    @field_validator('name_first', 'name_last')
    @classmethod
    def name_clean(cls, value: str) -> str:
        if not isinstance(value, str):
            message = f'a name must be a str: {type(value).__name__}'
            raise TypeError(message)

        name = value.strip()

        if len(name) > ACCOUNT_NAME_LENGTH_MAX:
            message = f'a name has at most {ACCOUNT_NAME_LENGTH_MAX} characters'
            raise ValueError(message)

        return name


class FunnelVisitSchema(Schema):
    campaign: CampaignChoices
    source: FunnelSourceChoices
