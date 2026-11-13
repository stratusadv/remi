from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.db import transaction

from django_spire.contrib.constructor.service import BaseDjangoModelService

from app.account.constants import QUESTION_TOKENS_MAX

if TYPE_CHECKING:
    from app.account.models import Account
    from app.account.question.models import AccountQuestion


class AccountQuestionFactoryService(BaseDjangoModelService['AccountQuestion']):
    obj: AccountQuestion

    def create(self, *, account: Account, tokens: int) -> AccountQuestion:
        if account.pk is None:
            message = f'account must be saved: {account!r}'
            raise ValueError(message)

        if not 0 < tokens <= QUESTION_TOKENS_MAX:
            message = f'tokens must be 1 to {QUESTION_TOKENS_MAX}: {tokens}'
            raise ValueError(message)

        if not self.model_obj_is_new:
            message = f'a question factory creates one question, and already holds {self.obj!r}'
            raise RuntimeError(message)

        if not transaction.get_connection().in_atomic_block:
            message = 'a question is written inside the transaction that locked its account'
            raise RuntimeError(message)

        self.obj.account = account
        self.obj.tokens = tokens

        _, created = self.save_model_obj()

        if not created:
            message = f'the question {self.obj!r} was updated instead of created'
            raise RuntimeError(message)

        return self.obj
