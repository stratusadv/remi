from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.contrib import admin, messages
from django.urls import reverse
from django.utils.html import format_html, format_html_join

from app.promo_code.models import PromoCode
from app.promo_code.querysets import PromoCodeQuerySet

if TYPE_CHECKING:
    from django.db.models import QuerySet
    from django.forms import ModelForm
    from django.http import HttpRequest


PROMO_CODE_ACTION_COUNT_MAX = 100

PROMO_CODE_FIELDS = (
    'code',
    'campaign',
    'hours',
    'redemptions_max',
    'early_codes_max',
    'early_hours',
    'early_codes_issued',
)

PROMO_CODE_FOLLOW_UP_DOWNLOADED = 'downloaded'
PROMO_CODE_FOLLOW_UP_EMAILED = 'emailed'
PROMO_CODE_REDEEMERS_LISTED_MAX = 25


class PromoCodeFollowUpFilter(admin.SimpleListFilter):
    parameter_name = 'follow_up'
    title = 'follow-up'

    def lookups(
        self,
        request: HttpRequest,
        model_admin: admin.ModelAdmin,
    ) -> list[tuple[str, str]]:
        _ = request
        _ = model_admin

        return [
            (PROMO_CODE_FOLLOW_UP_EMAILED, 'Emailed, never downloaded'),
            (PROMO_CODE_FOLLOW_UP_DOWNLOADED, 'Downloaded, never redeemed'),
        ]

    def queryset(
        self,
        request: HttpRequest,
        queryset: QuerySet[PromoCode],
    ) -> QuerySet[PromoCode]:
        _ = request

        if not isinstance(queryset, PromoCodeQuerySet):
            message = f'the promo code list must be a PromoCodeQuerySet: {type(queryset).__name__}'
            raise TypeError(message)

        waiting = queryset.issued().unredeemed()

        if self.value() == PROMO_CODE_FOLLOW_UP_EMAILED:
            return waiting.undownloaded()

        if self.value() == PROMO_CODE_FOLLOW_UP_DOWNLOADED:
            return waiting.downloaded()

        return queryset


@admin.register(PromoCode)
class PromoCodeAdmin(admin.ModelAdmin):
    actions = ['promo_activate', 'promo_deactivate']
    list_filter = ['campaign', 'is_active', PromoCodeFollowUpFilter]
    ordering = ['code']
    search_fields = ['code', 'email', 'name_first', 'name_last']

    list_display = [
        'code',
        'campaign',
        'name_first',
        'name_last',
        'email',
        'hours',
        'redemptions',
        'redemptions_max',
        'downloaded_datetime',
        'is_active',
        'created_datetime',
    ]

    def _promo_active_set(
        self,
        request: HttpRequest,
        queryset: QuerySet[PromoCode],
        *,
        is_active: bool,
    ) -> None:
        if queryset.count() > PROMO_CODE_ACTION_COUNT_MAX:
            message = f'Select at most {PROMO_CODE_ACTION_COUNT_MAX} promo codes at once.'
            self.message_user(request, message, messages.ERROR)

            return

        promos = queryset.order_by('pk')[:PROMO_CODE_ACTION_COUNT_MAX]

        for promo in promos:
            promo.services.processor.active_set(is_active=is_active)

    def get_fields(self, request: HttpRequest, obj: PromoCode | None = None) -> tuple[str, ...]:
        _ = request

        if obj is None:
            return PROMO_CODE_FIELDS

        return (*PROMO_CODE_FIELDS, 'redeemers')

    def get_queryset(self, request: HttpRequest) -> QuerySet[PromoCode]:
        _ = request

        return PromoCode.objects.with_redemption_count()

    def get_readonly_fields(
        self,
        request: HttpRequest,
        obj: PromoCode | None = None,
    ) -> list[str]:
        _ = request

        if obj is None:
            return ['early_codes_issued']

        if obj.email != '':
            return ['code', 'early_codes_issued', 'early_codes_max', 'early_hours', 'redeemers']

        return ['code', 'early_codes_issued', 'redeemers']

    @admin.action(description='Activate the selected promo codes', permissions=['change'])
    def promo_activate(self, request: HttpRequest, queryset: QuerySet[PromoCode]) -> None:
        self._promo_active_set(request, queryset, is_active=True)

    @admin.action(description='Deactivate the selected promo codes', permissions=['change'])
    def promo_deactivate(self, request: HttpRequest, queryset: QuerySet[PromoCode]) -> None:
        self._promo_active_set(request, queryset, is_active=False)

    @admin.display(description='Redeemed by')
    def redeemers(self, promo: PromoCode) -> str:
        redemptions = promo.redemptions.select_related('account').order_by('-created_datetime')
        redemptions_listed = redemptions[:PROMO_CODE_REDEEMERS_LISTED_MAX]
        accounts = [(redemption.account,) for redemption in redemptions_listed]
        listed = format_html_join('', '<div>{}</div>', accounts)
        remaining = promo.redemption_count - len(accounts)

        if remaining <= 0:
            return listed

        changelist = reverse('admin:account_ledger_accountledgerentry_changelist')
        url = f'{changelist}?promo_code__id__exact={promo.pk}'

        return format_html('{}<div><a href="{}">and {} more</a></div>', listed, url, remaining)

    @admin.display(description='Redemptions', ordering='redemption_count')
    def redemptions(self, promo: PromoCode) -> int:
        return promo.redemption_count

    def save_model(
        self,
        request: HttpRequest,
        obj: PromoCode,
        form: ModelForm,
        change: bool,
    ) -> None:
        if not isinstance(obj, PromoCode):
            message = f'obj must be a PromoCode: {type(obj).__name__}'
            raise TypeError(message)

        _ = request
        _ = form

        if not change:
            obj.services.save_model_obj()

            return

        obj.services.processor.terms_save(
            campaign=obj.campaign,
            hours=obj.hours,
            redemptions_max=obj.redemptions_max,
        )

        if obj.email == '':
            obj.services.processor.early_save(
                early_codes_max=obj.early_codes_max,
                early_hours=obj.early_hours,
            )
