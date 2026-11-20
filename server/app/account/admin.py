from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django import forms
from django.contrib import admin, messages
from django.contrib.auth.models import PermissionsMixin
from django.template.response import TemplateResponse
from django.utils import timezone

from app.account.constants import (
    ADJUSTMENT_HOURS_MAX,
    SECONDS_PER_HOUR,
    TOPUP_BALANCE_SECONDS,
)
from app.account.ledger.models import AccountLedgerEntry
from app.account.models import Account
from app.account.services.processor_service import hours_text
from app.core.exceptions import RefusalError

if TYPE_CHECKING:
    from decimal import Decimal

    from django.db.models import QuerySet
    from django.http import HttpRequest


ACCOUNT_ACTION_COUNT_MAX = 25
ADJUSTMENT_REASON_LENGTH_MAX = 100
ADJUSTMENT_TEMPLATE = 'admin/account/account/balance_adjust.html'
ADJUSTMENT_TITLE = 'Adjust balance'
PERMISSION_ACCOUNT_CHANGE = 'account.change_account'
TOPUP_HOURS = TOPUP_BALANCE_SECONDS // SECONDS_PER_HOUR


class AccountBalanceAdjustForm(forms.Form):
    required_css_class = 'required'

    hours = forms.DecimalField(
        decimal_places=2,
        help_text='A negative number removes hours.',
        max_digits=7,
    )

    reason = forms.CharField(
        help_text='The ledger keeps the reason with your username.',
        max_length=ADJUSTMENT_REASON_LENGTH_MAX,
    )

    def clean_hours(self) -> Decimal:
        hours = self.cleaned_data['hours']

        if hours == 0:
            message = 'Enter a number of hours other than zero.'
            raise forms.ValidationError(message)

        if abs(hours) > ADJUSTMENT_HOURS_MAX:
            message = f'Adjust by at most {ADJUSTMENT_HOURS_MAX:,} hours at a time.'
            raise forms.ValidationError(message)

        return hours


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
    actions = ['balance_adjust', 'code_issue', 'complimentary_end', 'complimentary_start']
    inlines = [AccountLedgerEntryInline]
    list_filter = ['campaign', 'is_active', 'is_complimentary', 'region']
    ordering = ['-created_datetime']
    search_fields = ['email', 'name']

    fields = [
        'name',
        'email',
        'campaign',
        'created_datetime',
        'balance_hours',
        'region',
        'is_complimentary',
        'is_active',
    ]

    list_display = [
        'name',
        'email',
        'campaign',
        'created_datetime',
        'balance_hours',
        'region',
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
        'region',
    ]

    def _balance_adjust_apply(
        self,
        request: HttpRequest,
        *,
        account: Account,
        form: AccountBalanceAdjustForm,
    ) -> bool:
        if not form.is_valid():
            message = 'only a valid adjustment form is applied'
            raise ValueError(message)

        try:
            reason = form.cleaned_data['reason']
            reference = f'{request.user.get_username()}: {reason}'
            seconds = int(form.cleaned_data['hours'] * SECONDS_PER_HOUR)

            balance_seconds = account.services.processor.balance_adjust(
                reference=reference,
                seconds=seconds,
            )
        except RefusalError as error:
            form.add_error(None, str(error))

            return False
        else:
            balance = hours_text(balance_seconds, rounded_up=False)
            message = f'The balance for {account.email} is now {balance}.'
            self.message_user(request, message, messages.SUCCESS)

            return True

    def _change_permitted(self, request: HttpRequest) -> bool:
        user = request.user

        if not isinstance(user, PermissionsMixin):
            return False

        return user.has_perm(PERMISSION_ACCOUNT_CHANGE)

    def _selection_bounded(self, request: HttpRequest, count: int) -> bool:
        if count < 0:
            message = f'count must not be negative: {count}'
            raise ValueError(message)

        if count <= ACCOUNT_ACTION_COUNT_MAX:
            return True

        message = f'Select at most {ACCOUNT_ACTION_COUNT_MAX} accounts at once.'
        self.message_user(request, message, messages.ERROR)

        return False

    @admin.action(description=ADJUSTMENT_TITLE, permissions=['balance_adjust'])
    def balance_adjust(
        self,
        request: HttpRequest,
        queryset: QuerySet[Account],
    ) -> TemplateResponse | None:
        if queryset.count() != 1:
            self.message_user(request, 'Select exactly one account.', messages.ERROR)

            return None

        account = queryset.get()
        data = request.POST if 'apply' in request.POST else None
        form = AccountBalanceAdjustForm(data)

        if form.is_valid():
            if self._balance_adjust_apply(request, account=account, form=form):
                return None

        balance_seconds = account.ledger_entries.balance_seconds()

        context = {
            **self.admin_site.each_context(request),
            'account': account,
            'balance': hours_text(balance_seconds, rounded_up=False),
            'form': form,
            'opts': self.opts,
            'title': ADJUSTMENT_TITLE,
        }

        return TemplateResponse(request, ADJUSTMENT_TEMPLATE, context)

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

    def has_balance_adjust_permission(self, request: HttpRequest) -> bool:
        return self._change_permitted(request)

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
