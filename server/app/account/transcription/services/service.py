from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django_spire.contrib.constructor.service import BaseDjangoModelService

from app.account.transcription.services.factory_service import (
    AccountTranscriptionChunkFactoryService,
)

if TYPE_CHECKING:
    from app.account.transcription.models import AccountTranscriptionChunk


class AccountTranscriptionChunkService(BaseDjangoModelService['AccountTranscriptionChunk']):
    obj: AccountTranscriptionChunk

    factory = AccountTranscriptionChunkFactoryService()
