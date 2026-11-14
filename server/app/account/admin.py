from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.contrib import admin, messages
from django.contrib.auth.models import PermissionsMixin
from django.utils import timezone

from app.account.constants import SECONDS_PER_HOUR, TOPUP_BALANCE_SECONDS
from app.account.ledger.models import AccountLedgerEntry
from app.account.models import Account

if TYPE_CHECKING:
    from django.db.models import QuerySet
    from django.http import HttpRequest


ACCOUNT_ACTION_COUNT_MAX = 25
PERMISSION_ACCOUNT_CHANGE = 'account.change_account'
TOPUP_HOURS = TOPUP_BALANCE_SECONDS // SECONDS_PER_HOUR


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
    actions = ['code_issue', 'complimentary_end', 'complimentary_start']
    inlines = [AccountLedgerEntryInline]
    list_filter = ['campaign', 'is_active', 'is_complimentary']
    ordering = ['-created_datetime']
    search_fields = ['email', 'name']

    fields = [
        'name',
        'email',
        'campaign',
        'created_datetime',
        'balance_hours',
        'is_complimentary',
        'is_active',
    ]

    list_display = [
        'name',
        'email',
        'campaign',
        'created_datetime',
        'balance_hours',
        'is_complimentary',
        'is_active',
    ]

    readonly_fields = [
        'balance_hours',
        'campaign',
        'created_datetime',
        'email',
        'is_active',
        'is_complimentary',
        'name',
    ]

    def _change_permitted(self, request: HttpRequest) -> bool:
        user = request.user

        if not isinstance(user, PermissionsMixin):
            return False

        return user.has_perm(PERMISSION_ACCOUNT_CHANGE)

    def _selection_bounded(self, request: HttpRequest, count: int) -> bool:
        if count <= ACCOUNT_ACTION_COUNT_MAX:
            return True

        message = f'Select at most {ACCOUNT_ACTION_COUNT_MAX} accounts at once.'
        self.message_user(request, message, messages.ERROR)

        return False

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

    @admin.action(description='End complimentary', permissions=['complimentary_end'])
    def complimentary_end(self, request: HttpRequest, queryset: QuerySet[Account]) -> None:
        count = queryset.count()

        if not self._selection_bounded(request, count):
            return

        accounts = queryset.order_by('pk')[:ACCOUNT_ACTION_COUNT_MAX]

        for account in accounts:
            account.services.processor.complimentary_end()

        message = 'The selected accounts are no longer complimentary. Their hours stay.'
        self.message_user(request, message, messages.SUCCESS)

    @admin.action(
        description=f'Make complimentary and top up to {TOPUP_HOURS:,} hours',
        permissions=['complimentary_start'],
    )
    def complimentary_start(self, request: HttpRequest, queryset: QuerySet[Account]) -> None:
        count = queryset.count()

        if not self._selection_bounded(request, count):
            return

        accounts = queryset.order_by('pk')[:ACCOUNT_ACTION_COUNT_MAX]
        reference = f'topup:{request.user.get_username()}:{timezone.now().isoformat()}'

        for account in accounts:
            _ = account.services.processor.complimentary_start(reference=reference)

        message = f'The selected accounts are complimentary, topped up to {TOPUP_HOURS:,} hours.'
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
        return self._change_permitted(request)

    def has_complimentary_end_permission(self, request: HttpRequest) -> bool:
        return self._change_permitted(request)

    def has_complimentary_start_permission(self, request: HttpRequest) -> bool:
        return self._change_permitted(request)
