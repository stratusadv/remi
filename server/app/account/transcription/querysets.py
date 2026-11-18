from __future__ import annotations

from typing_extensions import TYPE_CHECKING, Self

from django.db.models import QuerySet, Sum
from django.db.models.functions import Coalesce

from app.account.constants import CHARGE_JOB_ID_PATTERN, TRANSCRIPTION_CHUNK_DIGEST_PATTERN

if TYPE_CHECKING:
    from app.account.transcription.models import AccountTranscriptionChunk


class AccountTranscriptionChunkQuerySet(QuerySet['AccountTranscriptionChunk']):
    def by_digest(self, digest: str) -> Self:
        if TRANSCRIPTION_CHUNK_DIGEST_PATTERN.fullmatch(digest) is None:
            message = f'digest must be 32 lowercase hexadecimal characters: {digest!r}'
            raise ValueError(message)

        return self.filter(digest=digest)

    def by_job(self, job_id: str) -> Self:
        if CHARGE_JOB_ID_PATTERN.fullmatch(job_id) is None:
            message = f'job_id must be 32 lowercase hexadecimal characters: {job_id!r}'
            raise ValueError(message)

        return self.filter(job_id=job_id)

    def milliseconds_total(self) -> int:
        totals = self.aggregate(total=Coalesce(Sum('milliseconds'), 0))
        total = totals['total']

        if not isinstance(total, int):
            message = f'the millisecond sum must be an int: {type(total).__name__}'
            raise TypeError(message)

        return total
