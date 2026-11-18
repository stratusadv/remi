from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.db import models
from django.db.models import Q
from django.utils import timezone

from app.account.constants import TRANSCRIPTION_CHUNK_MILLISECONDS_MAX
from app.account.transcription import querysets
from app.account.transcription.services.service import AccountTranscriptionChunkService
from app.core.querysets import manager_for


class AccountTranscriptionChunk(models.Model):
    if TYPE_CHECKING:
        account_id: int

    account = models.ForeignKey(
        'account.Account',
        on_delete=models.PROTECT,
        related_name='transcription_chunks',
        related_query_name='transcription_chunk',
    )

    created_datetime = models.DateTimeField(default=timezone.now, editable=False)
    digest = models.CharField(max_length=32)
    job_id = models.CharField(max_length=32)
    milliseconds = models.PositiveIntegerField()

    objects = manager_for(querysets.AccountTranscriptionChunkQuerySet)
    services = AccountTranscriptionChunkService()

    class Meta:
        db_table = 'account_transcription_chunk'
        ordering = ['-created_datetime']
        verbose_name = 'Account Transcription Chunk'
        verbose_name_plural = 'Account Transcription Chunks'

        constraints = [
            models.CheckConstraint(
                condition=Q(
                    milliseconds__gt=0,
                    milliseconds__lte=TRANSCRIPTION_CHUNK_MILLISECONDS_MAX,
                ),
                name='account_transcription_chunk_milliseconds_bounded',
            ),
            models.UniqueConstraint(
                fields=['account', 'job_id', 'digest'],
                name='account_transcription_chunk_unique',
            ),
        ]

    def __str__(self) -> str:
        return f'{self.milliseconds} ms of recording {self.job_id}'
