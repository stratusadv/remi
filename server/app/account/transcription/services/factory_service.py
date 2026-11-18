from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.db import transaction

from django_spire.contrib.constructor.service import BaseDjangoModelService

from app.account.constants import (
    CHARGE_JOB_ID_PATTERN,
    TRANSCRIPTION_CHUNK_DIGEST_PATTERN,
    TRANSCRIPTION_CHUNK_MILLISECONDS_MAX,
)

if TYPE_CHECKING:
    from app.account.models import Account
    from app.account.transcription.models import AccountTranscriptionChunk


class AccountTranscriptionChunkFactoryService(
    BaseDjangoModelService['AccountTranscriptionChunk'],
):
    obj: AccountTranscriptionChunk

    def create(
        self,
        *,
        account: Account,
        digest: str,
        job_id: str,
        milliseconds: int,
    ) -> AccountTranscriptionChunk:
        if account.pk is None:
            message = f'account must be saved: {account!r}'
            raise ValueError(message)

        if TRANSCRIPTION_CHUNK_DIGEST_PATTERN.fullmatch(digest) is None:
            message = f'digest must be 32 lowercase hexadecimal characters: {digest!r}'
            raise ValueError(message)

        if CHARGE_JOB_ID_PATTERN.fullmatch(job_id) is None:
            message = f'job_id must be 32 lowercase hexadecimal characters: {job_id!r}'
            raise ValueError(message)

        if not 0 < milliseconds <= TRANSCRIPTION_CHUNK_MILLISECONDS_MAX:
            message = (
                f'milliseconds must be 1 to {TRANSCRIPTION_CHUNK_MILLISECONDS_MAX}: '
                f'{milliseconds}'
            )

            raise ValueError(message)

        if not self.model_obj_is_new:
            message = f'a chunk factory creates one chunk, and already holds {self.obj!r}'
            raise RuntimeError(message)

        if not transaction.get_connection().in_atomic_block:
            message = 'a chunk is written inside the transaction that locked its account'
            raise RuntimeError(message)

        self.obj.account = account
        self.obj.digest = digest
        self.obj.job_id = job_id
        self.obj.milliseconds = milliseconds

        _, created = self.save_model_obj()

        if not created:
            message = f'the chunk {self.obj!r} was updated instead of created'
            raise RuntimeError(message)

        return self.obj
