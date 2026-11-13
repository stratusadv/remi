from __future__ import annotations

from django.db import models
from django.db.models import Q
from django.db.models.functions import Upper

from django_spire.history.mixins import HistoryModelMixin

from app.core.querysets import manager_for
from app.funnel.choices import CampaignChoices
from app.promo_code import querysets
from app.promo_code.constants import PROMO_CODE_LENGTH_MAX
from app.promo_code.services.service import PromoCodeService


class PromoCode(HistoryModelMixin):
    campaign = models.CharField(
        max_length=16,
        choices=CampaignChoices.choices,
        default=CampaignChoices.GENERAL,
    )

    code = models.CharField(max_length=PROMO_CODE_LENGTH_MAX)
    hours = models.PositiveIntegerField()
    redemptions_max = models.PositiveIntegerField()

    objects = manager_for(querysets.PromoCodeQuerySet)
    services = PromoCodeService()

    class Meta:
        db_table = 'promo_code'
        ordering = ['code']
        verbose_name = 'Promo Code'
        verbose_name_plural = 'Promo Codes'

        constraints = [
            models.CheckConstraint(
                condition=Q(hours__gt=0),
                name='promo_code_hours_positive',
            ),
            models.UniqueConstraint(
                Upper('code'),
                name='promo_code_code_unique',
            ),
        ]

    def __str__(self) -> str:
        return self.code
