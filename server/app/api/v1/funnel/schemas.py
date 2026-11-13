from __future__ import annotations

from ninja import Schema

from app.funnel.choices import (
    CampaignChoices,
    FunnelPlatformChoices,
    FunnelSourceChoices,
)


class FunnelDownloadSchema(Schema):
    campaign: CampaignChoices
    platform: FunnelPlatformChoices


class FunnelVisitSchema(Schema):
    campaign: CampaignChoices
    source: FunnelSourceChoices
