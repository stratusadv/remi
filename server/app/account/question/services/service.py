from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django_spire.contrib.constructor.service import BaseDjangoModelService

from app.account.question.services.factory_service import AccountQuestionFactoryService

if TYPE_CHECKING:
    from app.account.question.models import AccountQuestion


class AccountQuestionService(BaseDjangoModelService['AccountQuestion']):
    obj: AccountQuestion

    factory = AccountQuestionFactoryService()
