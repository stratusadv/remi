from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.db import models
from django.db.models import Q
from django.utils import timezone

from app.account.constants import ACCOUNT_LEDGER_ENTRY_REFERENCE_LENGTH_MAX
from app.account.ledger import querysets
from app.account.ledger.choices import (
    ACCOUNT_LEDGER_ENTRY_KINDS_PAYMENT,
    AccountLedgerEntryKindChoices,
)
from app.account.ledger.services.service import AccountLedgerEntryService
from app.core.querysets import manager_for


class AccountLedgerEntry(models.Model):
    if TYPE_CHECKING:
        account_id: int
        payment_id: int | None
        promo_code_id: int | None

    account = models.ForeignKey(
        'account.Account',
        on_delete=models.PROTECT,
        related_name='ledger_entries',
        related_query_name='ledger_entry',
    )

    payment = models.ForeignKey(
        'account_payment.AccountPayment',
        blank=True,
        null=True,
        on_delete=models.PROTECT,
        related_name='ledger_entries',
        related_query_name='ledger_entry',
    )

    promo_code = models.ForeignKey(
        'promo_code.PromoCode',
        blank=True,
        null=True,
        on_delete=models.PROTECT,
        related_name='redemptions',
        related_query_name='redemption',
    )

    created_datetime = models.DateTimeField(default=timezone.now, editable=False)
    kind = models.CharField(max_length=16, choices=AccountLedgerEntryKindChoices.choices)
    reference = models.CharField(max_length=ACCOUNT_LEDGER_ENTRY_REFERENCE_LENGTH_MAX)
    seconds = models.BigIntegerField()

    objects = manager_for(querysets.AccountLedgerEntryQuerySet)
    services = AccountLedgerEntryService()

    class Meta:
        db_table = 'account_ledger_entry'
        ordering = ['-created_datetime']
        verbose_name = 'Account Ledger Entry'
        verbose_name_plural = 'Account Ledger Entries'

        constraints = [
            models.CheckConstraint(
                condition=(
                    Q(kind=AccountLedgerEntryKindChoices.CHARGE, seconds__lt=0)
                    | Q(kind=AccountLedgerEntryKindChoices.GRANT, seconds__gt=0)
                    | Q(kind=AccountLedgerEntryKindChoices.PROMO, seconds__gt=0)
                    | Q(kind=AccountLedgerEntryKindChoices.PURCHASE, seconds__gt=0)
                    | Q(kind=AccountLedgerEntryKindChoices.REINSTATEMENT, seconds__gte=0)
                    | Q(kind=AccountLedgerEntryKindChoices.REVERSAL, seconds__lte=0)
                ),
                name='account_ledger_entry_seconds_signed_by_kind',
            ),
            models.CheckConstraint(
                condition=(
                    Q(kind__in=ACCOUNT_LEDGER_ENTRY_KINDS_PAYMENT, payment__isnull=False)
                    | (~Q(kind__in=ACCOUNT_LEDGER_ENTRY_KINDS_PAYMENT) & Q(payment__isnull=True))
                ),
                name='account_ledger_entry_payment_set_by_kind',
            ),
            models.CheckConstraint(
                condition=(
                    Q(kind=AccountLedgerEntryKindChoices.PROMO, promo_code__isnull=False)
                    | (~Q(kind=AccountLedgerEntryKindChoices.PROMO) & Q(promo_code__isnull=True))
                ),
                name='account_ledger_entry_promo_code_set_by_kind',
            ),
            models.UniqueConstraint(
                fields=['account', 'kind', 'reference'],
                name='account_ledger_entry_reference_unique',
            ),
        ]

    def __str__(self) -> str:
        return f'{self.kind} of {self.seconds} seconds ({self.reference})'
