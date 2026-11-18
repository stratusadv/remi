from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.contrib import admin

from app.account.payment.models import AccountPayment

if TYPE_CHECKING:
    from django.http import HttpRequest


@admin.register(AccountPayment)
class AccountPaymentAdmin(admin.ModelAdmin):
    date_hierarchy = 'created_datetime'
    list_select_related = ['account']
    ordering = ['-created_datetime']

    list_display = [
        'created_datetime',
        'account',
        'amount_cents',
        'currency',
        'seconds',
        'stripe_payment_intent_id',
    ]

    search_fields = [
        'account__email',
        'stripe_checkout_session_id',
        'stripe_payment_intent_id',
    ]

    def has_add_permission(self, request: HttpRequest) -> bool:
        _ = request

        return False

    def has_change_permission(
        self,
        request: HttpRequest,
        obj: AccountPayment | None = None,
    ) -> bool:
        _ = request
        _ = obj

        return False

    def has_delete_permission(
        self,
        request: HttpRequest,
        obj: AccountPayment | None = None,
    ) -> bool:
        _ = request
        _ = obj

        return False
