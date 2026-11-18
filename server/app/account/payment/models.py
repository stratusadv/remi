from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.db import models
from django.db.models import Q
from django.utils import timezone

from app.account.constants import PAYMENT_CURRENCY_LENGTH, STRIPE_ID_LENGTH_MAX
from app.account.payment import querysets
from app.account.payment.services.service import AccountPaymentService
from app.core.querysets import manager_for

if TYPE_CHECKING:
    from app.account.ledger.querysets import AccountLedgerEntryQuerySet


class AccountPayment(models.Model):
    if TYPE_CHECKING:
        account_id: int
        ledger_entries: AccountLedgerEntryQuerySet

    account = models.ForeignKey(
        'account.Account',
        on_delete=models.PROTECT,
        related_name='payments',
        related_query_name='payment',
    )

    amount_cents = models.PositiveIntegerField(blank=True, null=True)
    created_datetime = models.DateTimeField(default=timezone.now, editable=False)
    currency = models.CharField(max_length=PAYMENT_CURRENCY_LENGTH)
    seconds = models.PositiveBigIntegerField()
    stripe_checkout_session_id = models.CharField(max_length=STRIPE_ID_LENGTH_MAX, unique=True)

    stripe_payment_intent_id = models.CharField(
        blank=True,
        max_length=STRIPE_ID_LENGTH_MAX,
        null=True,
        unique=True,
    )

    objects = manager_for(querysets.AccountPaymentQuerySet)
    services = AccountPaymentService()

    class Meta:
        db_table = 'account_payment'
        ordering = ['-created_datetime']
        verbose_name = 'Account Payment'
        verbose_name_plural = 'Account Payments'

        constraints = [
            models.CheckConstraint(
                condition=Q(currency__regex=r'^[a-z]{3}$'),
                name='account_payment_currency_code',
            ),
            models.CheckConstraint(
                condition=(
                    Q(stripe_payment_intent_id__isnull=True)
                    | Q(stripe_payment_intent_id__startswith='pi_')
                ),
                name='account_payment_payment_intent_named',
            ),
            models.CheckConstraint(
                condition=Q(seconds__gt=0),
                name='account_payment_seconds_positive',
            ),
        ]

    def __str__(self) -> str:
        return f'{self.amount_cents} {self.currency} for {self.seconds} seconds'
