from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.contrib import admin, messages
from django.contrib.auth.models import PermissionsMixin

from app.account.constants import SECONDS_PER_HOUR
from app.account.ledger.models import AccountLedgerEntry
from app.account.models import Account

if TYPE_CHECKING:
    from django.db.models import QuerySet
    from django.http import HttpRequest


PERMISSION_ACCOUNT_CHANGE = 'account.change_account'


class AccountLedgerEntryInline(admin.TabularInline):
    can_delete = False
    extra = 0
    fields = ['created_datetime', 'kind', 'seconds', 'reference']
    model = AccountLedgerEntry
    ordering = ['-created_datetime']
    readonly_fields = ['created_datetime', 'kind', 'reference', 'seconds']

    def has_add_permission(self, request: HttpRequest, obj: Account | None = None) -> bool:
        _ = request
        _ = obj

        return False


@admin.register(Account)
class AccountAdmin(admin.ModelAdmin):
    actions = ['code_issue']
    inlines = [AccountLedgerEntryInline]
    list_filter = ['campaign', 'is_active']
    ordering = ['-created_datetime']
    search_fields = ['email', 'name']

    fields = [
        'name',
        'email',
        'campaign',
        'created_datetime',
        'balance_hours',
        'is_active',
    ]

    list_display = [
        'name',
        'email',
        'campaign',
        'created_datetime',
        'balance_hours',
        'is_active',
    ]

    readonly_fields = [
        'balance_hours',
        'campaign',
        'created_datetime',
        'email',
        'is_active',
        'name',
    ]

    @admin.display(description='Balance (hours)', ordering='balance_seconds')
    def balance_hours(self, account: Account) -> str:
        balance_seconds = getattr(account, 'balance_seconds', None)

        if balance_seconds is None:
            balance_seconds = account.ledger_entries.balance_seconds()

        return f'{balance_seconds / SECONDS_PER_HOUR:.1f}'

    @admin.action(description='Issue a new sign-in code', permissions=['code_issue'])
    def code_issue(self, request: HttpRequest, queryset: QuerySet[Account]) -> None:
        if queryset.count() != 1:
            self.message_user(request, 'Select exactly one account.', messages.ERROR)

            return

        account = queryset.get()
        token = account.services.processor.token_issue()
        message = (
            f'The sign-in code for {account.email} is now {token}. '
            f'The old code stops working.'
        )

        self.message_user(request, message, messages.SUCCESS)

    def get_queryset(self, request: HttpRequest) -> QuerySet[Account]:
        _ = request

        return Account.objects.with_balance()

    def has_add_permission(self, request: HttpRequest) -> bool:
        _ = request

        return False

    def has_change_permission(self, request: HttpRequest, obj: Account | None = None) -> bool:
        _ = request
        _ = obj

        return False

    def has_code_issue_permission(self, request: HttpRequest) -> bool:
        user = request.user

        if not isinstance(user, PermissionsMixin):
            return False

        return user.has_perm(PERMISSION_ACCOUNT_CHANGE)
