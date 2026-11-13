from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.db import models
from django.db.models import Q
from django.utils import timezone

from app.account.constants import QUESTION_TOKENS_MAX
from app.account.question import querysets
from app.account.question.services.service import AccountQuestionService
from app.core.querysets import manager_for


class AccountQuestion(models.Model):
    if TYPE_CHECKING:
        account_id: int

    account = models.ForeignKey(
        'account.Account',
        on_delete=models.PROTECT,
        related_name='questions',
        related_query_name='question',
    )

    created_datetime = models.DateTimeField(default=timezone.now, editable=False)
    finished_datetime = models.DateTimeField(blank=True, editable=False, null=True)
    tokens = models.PositiveIntegerField()

    objects = manager_for(querysets.AccountQuestionQuerySet)
    services = AccountQuestionService()

    class Meta:
        db_table = 'account_question'
        ordering = ['-created_datetime']
        verbose_name = 'Account Question'
        verbose_name_plural = 'Account Questions'

        constraints = [
            models.CheckConstraint(
                condition=Q(tokens__gt=0, tokens__lte=QUESTION_TOKENS_MAX),
                name='account_question_tokens_bounded',
            ),
        ]

        indexes = [
            models.Index(
                fields=['account', 'created_datetime'],
                name='account_question_recent',
            ),
        ]

    def __str__(self) -> str:
        return f'{self.tokens} tokens asked {self.created_datetime:%Y-%m-%d %H:%M}'
