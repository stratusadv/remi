from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.contrib import admin, messages

from app.account.ledger.models import AccountLedgerEntry
from app.promo_code.models import PromoCode
from app.promo_code.querysets import PromoCodeQuerySet

if TYPE_CHECKING:
    from django.db.models import QuerySet
    from django.forms import ModelForm
    from django.http import HttpRequest


PROMO_CODE_ACTION_COUNT_MAX = 100
PROMO_CODE_FOLLOW_UP_DOWNLOADED = 'downloaded'
PROMO_CODE_FOLLOW_UP_EMAILED = 'emailed'


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
    fields = ['code', 'campaign', 'hours', 'redemptions_max']
    list_filter = ['campaign', 'is_active', PromoCodeFollowUpFilter]
    ordering = ['code']
    search_fields = ['code', 'email']

    list_display = [
        'code',
        'campaign',
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

    def get_readonly_fields(
        self,
        request: HttpRequest,
        obj: PromoCode | None = None,
    ) -> list[str]:
        _ = request

        if obj is None:
            return []

        return ['code']

    @admin.action(description='Activate the selected promo codes', permissions=['change'])
    def promo_activate(self, request: HttpRequest, queryset: QuerySet[PromoCode]) -> None:
        self._promo_active_set(request, queryset, is_active=True)

    @admin.action(description='Deactivate the selected promo codes', permissions=['change'])
    def promo_deactivate(self, request: HttpRequest, queryset: QuerySet[PromoCode]) -> None:
        self._promo_active_set(request, queryset, is_active=False)

    @admin.display(description='Redemptions')
    def redemptions(self, promo: PromoCode) -> int:
        return AccountLedgerEntry.objects.promos().by_reference(promo.code).count()

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
