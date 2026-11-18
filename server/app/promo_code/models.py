from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.db import models
from django.db.models import Q
from django.db.models.functions import Upper

from django_spire.history.mixins import HistoryModelMixin

from app.account.constants import ACCOUNT_EMAIL_LENGTH_MAX, ACCOUNT_NAME_LENGTH_MAX
from app.core.querysets import manager_for
from app.funnel.choices import CampaignChoices
from app.promo_code import querysets
from app.promo_code.constants import PROMO_CODE_EARLY_HOURS_MESSAGE, PROMO_CODE_LENGTH_MAX
from app.promo_code.services.service import PromoCodeService

if TYPE_CHECKING:
    from app.account.ledger.querysets import AccountLedgerEntryQuerySet


class PromoCode(HistoryModelMixin):
    if TYPE_CHECKING:
        redemption_count: int
        redemptions: AccountLedgerEntryQuerySet

    campaign = models.CharField(
        max_length=16,
        choices=CampaignChoices.choices,
        default=CampaignChoices.GENERAL,
    )

    code = models.CharField(max_length=PROMO_CODE_LENGTH_MAX)
    downloaded_datetime = models.DateTimeField(blank=True, editable=False, null=True)
    early_codes_issued = models.PositiveIntegerField(default=0, editable=False)
    early_codes_max = models.PositiveIntegerField(default=0)
    early_hours = models.PositiveIntegerField(default=0)

    email = models.EmailField(
        blank=True,
        default='',
        editable=False,
        max_length=ACCOUNT_EMAIL_LENGTH_MAX,
    )

    hours = models.PositiveIntegerField()

    name_first = models.CharField(
        blank=True,
        default='',
        editable=False,
        max_length=ACCOUNT_NAME_LENGTH_MAX,
        verbose_name='first name',
    )

    name_last = models.CharField(
        blank=True,
        default='',
        editable=False,
        max_length=ACCOUNT_NAME_LENGTH_MAX,
        verbose_name='last name',
    )

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
            models.CheckConstraint(
                condition=Q(early_codes_max=0) | Q(early_hours__gt=0),
                name='promo_code_early_hours_set_by_codes_max',
                violation_error_message=PROMO_CODE_EARLY_HOURS_MESSAGE,
            ),
            models.CheckConstraint(
                condition=Q(email='') | Q(early_codes_issued=0, early_codes_max=0, early_hours=0),
                name='promo_code_early_terms_shared_only',
            ),
            models.UniqueConstraint(
                'campaign',
                Upper('email'),
                condition=~Q(email=''),
                name='promo_code_campaign_email_unique',
            ),
            models.UniqueConstraint(
                Upper('code'),
                name='promo_code_code_unique',
            ),
        ]

    def __str__(self) -> str:
        return self.code
