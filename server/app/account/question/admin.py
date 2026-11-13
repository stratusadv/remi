from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.contrib import admin

from app.account.question.models import AccountQuestion

if TYPE_CHECKING:
    from django.http import HttpRequest


@admin.register(AccountQuestion)
class AccountQuestionAdmin(admin.ModelAdmin):
    date_hierarchy = 'created_datetime'
    list_display = ['created_datetime', 'account', 'tokens', 'finished_datetime']
    list_select_related = ['account']
    ordering = ['-created_datetime']
    search_fields = ['account__email']

    def has_add_permission(self, request: HttpRequest) -> bool:
        _ = request

        return False

    def has_change_permission(
        self,
        request: HttpRequest,
        obj: AccountQuestion | None = None,
    ) -> bool:
        _ = request
        _ = obj

        return False

    def has_delete_permission(
        self,
        request: HttpRequest,
        obj: AccountQuestion | None = None,
    ) -> bool:
        _ = request
        _ = obj

        return False
