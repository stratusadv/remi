from __future__ import annotations

from app.funnel.choices import CampaignChoices
from app.promo_code.constants import PROMO_CODE_LENGTH_MAX
from app.promo_code.models import PromoCode


def create_test_promo_code(
    *,
    campaign: str = CampaignChoices.GENERAL,
    code: str = 'WIB2026',
    early_codes_max: int = 0,
    early_hours: int = 0,
    hours: int = 250,
    is_active: bool = True,
    redemptions_max: int = 100,
) -> PromoCode:
    assert campaign in CampaignChoices.values
    assert 0 < len(code) <= PROMO_CODE_LENGTH_MAX
    assert early_codes_max >= 0
    assert early_hours >= 0
    assert hours > 0
    assert redemptions_max >= 0

    return PromoCode.objects.create(
        campaign=campaign,
        code=code,
        early_codes_max=early_codes_max,
        early_hours=early_hours,
        hours=hours,
        is_active=is_active,
        redemptions_max=redemptions_max,
    )
