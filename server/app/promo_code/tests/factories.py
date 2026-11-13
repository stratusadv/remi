from __future__ import annotations

from app.funnel.choices import CampaignChoices
from app.promo_code.models import PromoCode


def create_test_promo_code(
    *,
    campaign: str = CampaignChoices.GENERAL,
    code: str = 'WIB2026',
    hours: int = 250,
    is_active: bool = True,
    redemptions_max: int = 100,
) -> PromoCode:
    return PromoCode.objects.create(
        campaign=campaign,
        code=code,
        hours=hours,
        is_active=is_active,
        redemptions_max=redemptions_max,
    )
