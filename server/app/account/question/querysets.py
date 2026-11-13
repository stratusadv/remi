from __future__ import annotations

from datetime import datetime
from typing_extensions import TYPE_CHECKING, NamedTuple, Self

from django.db.models import Count, Max, QuerySet, Sum
from django.db.models.functions import Coalesce

if TYPE_CHECKING:
    from app.account.question.models import AccountQuestion


class AccountQuestionTotals(NamedTuple):
    asked_last: datetime | None
    question_count: int
    tokens: int


class AccountQuestionQuerySet(QuerySet['AccountQuestion']):
    def asked_latest(self, count: int) -> list[datetime]:
        if count <= 0:
            message = f'count must be positive: {count}'
            raise ValueError(message)

        latest = self.order_by('-created_datetime').values_list('created_datetime', flat=True)

        return sorted(latest[:count])

    def by_id(self, question_id: int) -> Self:
        if question_id <= 0:
            message = f'question_id must be positive: {question_id}'
            raise ValueError(message)

        return self.filter(pk=question_id)

    def locked(self) -> Self:
        return self.select_for_update()

    def since(self, moment: datetime) -> Self:
        if moment.tzinfo is None:
            message = f'moment must carry a time zone: {moment!r}'
            raise ValueError(message)

        return self.filter(created_datetime__gt=moment)

    def totals(self) -> AccountQuestionTotals:
        aggregated = self.aggregate(
            asked_last=Max('created_datetime'),
            question_count=Count('pk'),
            tokens=Coalesce(Sum('tokens'), 0),
        )

        asked_last = aggregated['asked_last']
        question_count = aggregated['question_count']
        tokens = aggregated['tokens']

        if asked_last is not None:
            if not isinstance(asked_last, datetime):
                message = f'the last question time must be a datetime: {type(asked_last).__name__}'
                raise TypeError(message)

        if not isinstance(question_count, int):
            message = f'the question count must be an int: {type(question_count).__name__}'
            raise TypeError(message)

        if not isinstance(tokens, int):
            message = f'the token sum must be an int: {type(tokens).__name__}'
            raise TypeError(message)

        return AccountQuestionTotals(
            asked_last=asked_last,
            question_count=question_count,
            tokens=tokens,
        )
