from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.contrib import admin

from app.account.ledger.models import AccountLedgerEntry

if TYPE_CHECKING:
    from django.http import HttpRequest


@admin.register(AccountLedgerEntry)
class AccountLedgerEntryAdmin(admin.ModelAdmin):
    list_display = ['created_datetime', 'account', 'kind', 'seconds', 'reference']
    list_filter = ['kind']
    list_select_related = ['account']
    ordering = ['-created_datetime']
    search_fields = ['account__email', 'reference']

    def has_add_permission(self, request: HttpRequest) -> bool:
        _ = request

        return False

    def has_change_permission(
        self,
        request: HttpRequest,
        obj: AccountLedgerEntry | None = None,
    ) -> bool:
        _ = request
        _ = obj

        return False

    def has_delete_permission(
        self,
        request: HttpRequest,
        obj: AccountLedgerEntry | None = None,
    ) -> bool:
        _ = request
        _ = obj

        return False
