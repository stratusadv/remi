from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.contrib import admin

from app.account.transcription.models import AccountTranscriptionChunk

if TYPE_CHECKING:
    from django.http import HttpRequest


@admin.register(AccountTranscriptionChunk)
class AccountTranscriptionChunkAdmin(admin.ModelAdmin):
    date_hierarchy = 'created_datetime'
    list_display = ['created_datetime', 'account', 'job_id', 'milliseconds']
    list_select_related = ['account']
    ordering = ['-created_datetime']
    search_fields = ['account__email', 'job_id']

    def has_add_permission(self, request: HttpRequest) -> bool:
        _ = request

        return False

    def has_change_permission(
        self,
        request: HttpRequest,
        obj: AccountTranscriptionChunk | None = None,
    ) -> bool:
        _ = request
        _ = obj

        return False

    def has_delete_permission(
        self,
        request: HttpRequest,
        obj: AccountTranscriptionChunk | None = None,
    ) -> bool:
        _ = request
        _ = obj

        return False
