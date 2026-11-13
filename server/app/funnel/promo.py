from __future__ import annotations

import logging

from app.core.exceptions import EmailUnavailableError
from app.funnel.choices import CampaignChoices
from app.funnel.constants import FUNNEL_PROMO_CODES_SHARED
from app.promo_code.models import PromoCode


FUNNEL_OFFER_UNSET_MESSAGE = 'The conference offer is not set up on the server yet.'
logger = logging.getLogger(__name__)


def funnel_promo_downloaded(code: str) -> None:
    if code == '':
        message = 'code must be non-empty'
        raise ValueError(message)

    promo = PromoCode.objects.issued().by_code(code).first()

    if promo is None:
        return

    promo.services.processor.download_record()


def funnel_promo_issue(*, address: str, campaign: str) -> PromoCode | None:
    if campaign not in CampaignChoices.values:
        message = f'campaign must be one of {CampaignChoices.values}: {campaign!r}'
        raise ValueError(message)

    if address == '':
        message = 'address must be non-empty'
        raise ValueError(message)

    code_shared = FUNNEL_PROMO_CODES_SHARED.get(CampaignChoices(campaign))

    if code_shared is None:
        return None

    shared = PromoCode.objects.active().shared().by_code(code_shared).first()

    if shared is None:
        logger.error('The %s campaign has no active shared promo code %s', campaign, code_shared)
        raise EmailUnavailableError(FUNNEL_OFFER_UNSET_MESSAGE)

    return shared.services.processor.issue(address)
