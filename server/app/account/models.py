from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.db import models

from django_spire.history.mixins import HistoryModelMixin

from app.account import querysets
from app.account.constants import (
    ACCOUNT_EMAIL_LENGTH_MAX,
    ACCOUNT_NAME_LENGTH_MAX,
    ACCOUNT_TOKEN_HASH_LENGTH,
)
from app.account.services.service import AccountService
from app.core.querysets import manager_for
from app.funnel.choices import CampaignChoices

if TYPE_CHECKING:
    from app.account.ledger.querysets import AccountLedgerEntryQuerySet
    from app.account.question.querysets import AccountQuestionQuerySet


class Account(HistoryModelMixin):
    if TYPE_CHECKING:
        ledger_entries: AccountLedgerEntryQuerySet
        questions: AccountQuestionQuerySet

    campaign = models.CharField(
        max_length=16,
        choices=CampaignChoices.choices,
        default=CampaignChoices.GENERAL,
    )

    email = models.EmailField(max_length=ACCOUNT_EMAIL_LENGTH_MAX)
    name = models.CharField(max_length=ACCOUNT_NAME_LENGTH_MAX)

    token_hash = models.CharField(
        max_length=ACCOUNT_TOKEN_HASH_LENGTH,
        unique=True,
        editable=False,
    )

    objects = manager_for(querysets.AccountQuerySet)
    services = AccountService()

    class Meta:
        db_table = 'account'
        ordering = ['-created_datetime']
        verbose_name = 'Account'
        verbose_name_plural = 'Accounts'

    def __str__(self) -> str:
        return f'{self.name} <{self.email}>'
