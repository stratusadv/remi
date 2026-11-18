from __future__ import annotations

import re

import pytest

from datetime import UTC, datetime, timedelta
from functools import partialmethod
from typing_extensions import TYPE_CHECKING, cast

from django.db import transaction

from app.account.constants import QUESTION_TOKENS_MAX
from app.account.question import pace
from app.account.question.models import AccountQuestion
from app.account.question.pace import AskLimits, AskPace, AskUsage, ask_pace
from app.account.question.querysets import AccountQuestionQuerySet
from app.account.question.services.factory_service import AccountQuestionFactoryService
from app.account.tests.factories import create_test_account

if TYPE_CHECKING:
    from collections.abc import Callable

    from django.db.models import Model

    from app.account.models import Account


pytestmark = pytest.mark.django_db
NOW = datetime(2026, 11, 16, 9, 30, tzinfo=UTC)
NOW_NAIVE = NOW.replace(tzinfo=None)

LIMITS = AskLimits(
    burst_count=3,
    burst_seconds=600,
    pace_seconds=300,
    tokens_estimate=1000,
    tokens_soft_cap=10_000,
    window_days=30,
)

USAGE_EMPTY = AskUsage(asked_burst=(), asked_last=None, question_count=0, tokens=0)


def _aggregate_replied(
    queryset: AccountQuestionQuerySet,
    *,
    reply: dict[str, object],
    **expressions: object,
) -> dict[str, object]:
    _ = queryset

    assert reply.keys() == expressions.keys()

    return reply


def _question_create(account: Account, *, tokens: int = 1000) -> AccountQuestion:
    assert 0 < tokens <= QUESTION_TOKENS_MAX

    question = AccountQuestion.services.factory.create(account=account, tokens=tokens)

    assert question.pk is not None
    assert question.tokens == tokens

    return question


def _save_reported_as_update(
    service: AccountQuestionFactoryService,
    *,
    save: Callable[[AccountQuestionFactoryService], tuple[Model, bool]],
) -> tuple[Model, bool]:
    assert service.model_obj_is_new

    saved, created = save(service)

    assert created

    return saved, False


def test_pace_helpers_refuse_a_clock_without_a_zone() -> None:
    usage = AskUsage(asked_burst=(NOW,), asked_last=NOW, question_count=1, tokens=20_000)

    with pytest.raises(ValueError, match='moment must carry a time zone'):
        pace._seconds_until(moment=NOW_NAIVE, now=NOW)

    with pytest.raises(ValueError, match='now must carry a time zone'):
        pace._seconds_until(moment=NOW, now=NOW_NAIVE)

    with pytest.raises(ValueError, match='now must carry a time zone'):
        pace._wait_burst_seconds(limits=LIMITS, now=NOW_NAIVE, usage=usage)

    with pytest.raises(ValueError, match='now must carry a time zone'):
        pace._wait_pace_seconds(limits=LIMITS, now=NOW_NAIVE, usage=usage)

    assert pace._wait_burst_seconds(limits=LIMITS, now=NOW, usage=usage) == 0
    assert pace._wait_pace_seconds(limits=LIMITS, now=NOW, usage=usage) == LIMITS.pace_seconds


def test_pace_helpers_refuse_counts_that_are_not_positive() -> None:
    limits_cap_zero = LIMITS._replace(tokens_soft_cap=0)
    limits_pace_zero = LIMITS._replace(pace_seconds=0)
    usage_negative = USAGE_EMPTY._replace(tokens=-1)
    message_cap = f'the soft cap must be positive: {limits_cap_zero.tokens_soft_cap}'
    message_pace = f'the pace must be positive: {limits_pace_zero.pace_seconds}'

    for seconds in (0, -60):
        with pytest.raises(ValueError, match=f'seconds must be positive: {seconds}'):
            pace._minutes_text(seconds)

        with pytest.raises(ValueError, match=f'seconds must be positive: {seconds}'):
            pace._wait_text(seconds)

    with pytest.raises(ValueError, match=message_cap):
        pace._notice(limits_cap_zero, USAGE_EMPTY)

    with pytest.raises(ValueError, match='tokens must not be negative: -1'):
        pace._notice(LIMITS, usage_negative)

    with pytest.raises(ValueError, match=message_pace):
        pace._wait_pace_seconds(limits=limits_pace_zero, now=NOW, usage=USAGE_EMPTY)

    with pytest.raises(ValueError, match='tokens must not be negative: -1'):
        pace._wait_pace_seconds(limits=LIMITS, now=NOW, usage=usage_negative)

    assert pace._minutes_text(1) == '1 minute'
    assert pace._notice(LIMITS, USAGE_EMPTY) == ''
    assert pace._wait_pace_seconds(limits=LIMITS, now=NOW, usage=USAGE_EMPTY) == 0


def test_pace_wait_texts_name_the_minutes_rounded_up_and_under_a_minute_below() -> None:
    examples = [
        (1, 'in under a minute'),
        (59, 'in under a minute'),
        (60, 'in about 1 minute'),
        (61, 'in about 2 minutes'),
        (600, 'in about 10 minutes'),
    ]

    for seconds, expected in examples:
        assert pace._wait_text(seconds) == expected, seconds


def test_questions_left_from_the_estimate_when_none_was_asked_and_never_past_the_cap() -> None:
    usage_estimated = USAGE_EMPTY._replace(tokens=6000)
    usage_capped = USAGE_EMPTY._replace(tokens=LIMITS.tokens_soft_cap)
    usage_impossible = USAGE_EMPTY._replace(tokens=-LIMITS.tokens_soft_cap)
    limits_one = LIMITS._replace(tokens_estimate=1)
    message_cap = f'{usage_capped.tokens} tokens leaves no full-speed question under the soft cap'
    message_negative = f'tokens must not be negative: {usage_impossible.tokens}'

    assert pace._questions_left(LIMITS, usage_estimated) == 4
    assert pace._questions_left(limits_one, USAGE_EMPTY) == LIMITS.tokens_soft_cap

    with pytest.raises(ValueError, match=message_cap):
        pace._questions_left(LIMITS, usage_capped)

    with pytest.raises(RuntimeError, match='questions left is more than the soft cap'):
        pace._questions_left(limits_one, usage_impossible)

    with pytest.raises(ValueError, match=message_negative):
        pace._notice(limits_one, usage_impossible)


def test_burst_wait_refuses_an_overfull_burst_and_a_last_question_outside_it() -> None:
    asked = tuple(NOW - timedelta(seconds=seconds) for seconds in (40, 30, 20, 10))
    overfull = AskUsage(asked_burst=asked, asked_last=asked[-1], question_count=4, tokens=4)
    full = overfull._replace(asked_burst=asked[1:], question_count=3)
    stale_last = NOW - timedelta(seconds=5)
    misplaced = AskUsage(asked_burst=asked[:2], asked_last=stale_last, question_count=2, tokens=2)
    placed = misplaced._replace(asked_last=asked[1])

    with pytest.raises(ValueError, match='4 questions overfill a burst of 3'):
        pace._wait_burst_seconds(limits=LIMITS, now=NOW, usage=overfull)

    with pytest.raises(ValueError, match='the last question asked is not the newest'):
        pace._usage_validate(limits=LIMITS, now=NOW, usage=misplaced)

    assert pace._wait_burst_seconds(limits=LIMITS, now=NOW, usage=full) == LIMITS.burst_seconds - 30
    assert ask_pace(limits=LIMITS, now=NOW, usage=placed) == AskPace(notice='', wait_seconds=0)


def test_pace_wait_past_the_cap_without_a_question_is_refused() -> None:
    usage = USAGE_EMPTY._replace(tokens=LIMITS.tokens_soft_cap)
    usage_asked = usage._replace(asked_last=NOW, question_count=1)
    usage_under = usage._replace(tokens=LIMITS.tokens_soft_cap - 1)

    with pytest.raises(ValueError, match='tokens were counted without a question'):
        pace._wait_pace_seconds(limits=LIMITS, now=NOW, usage=usage)

    assert pace._wait_pace_seconds(limits=LIMITS, now=NOW, usage=usage_asked) == LIMITS.pace_seconds
    assert pace._wait_pace_seconds(limits=LIMITS, now=NOW, usage=usage_under) == 0


def test_ask_pace_and_limits_refuse_arguments_of_the_wrong_type() -> None:
    limits_tuple = cast('AskLimits', tuple(LIMITS))
    usage_tuple = cast('AskUsage', tuple(USAGE_EMPTY))
    now_text = cast('datetime', NOW.isoformat())
    message_usage = f'usage must be AskUsage: {type(usage_tuple).__name__}'
    message_now = f'now must be a datetime: {type(now_text).__name__}'

    with pytest.raises(TypeError, match='limits must be AskLimits: tuple'):
        pace._limits_validate(limits_tuple)

    with pytest.raises(TypeError, match='limits must be AskLimits: tuple'):
        ask_pace(limits=limits_tuple, now=NOW, usage=USAGE_EMPTY)

    with pytest.raises(TypeError, match=message_usage):
        ask_pace(limits=LIMITS, now=NOW, usage=usage_tuple)

    with pytest.raises(TypeError, match=message_now):
        ask_pace(limits=LIMITS, now=now_text, usage=USAGE_EMPTY)

    pace_empty = ask_pace(limits=LIMITS, now=NOW, usage=USAGE_EMPTY)

    assert pace_empty == AskPace(notice='', wait_seconds=0)


def test_question_filters_refuse_counts_ids_and_times_that_cannot_be_asked() -> None:
    questions = AccountQuestion.objects.all()

    for count in (0, -1):
        with pytest.raises(ValueError, match=f'count must be positive: {count}'):
            questions.asked_latest(count)

    for question_id in (0, -1):
        with pytest.raises(ValueError, match=f'question_id must be positive: {question_id}'):
            questions.by_id(question_id)

    with pytest.raises(ValueError, match='moment must carry a time zone'):
        questions.since(NOW_NAIVE)

    assert questions.asked_latest(1) == []
    assert not questions.by_id(1).exists()
    assert not questions.since(NOW).exists()


def test_question_totals_of_the_wrong_type_are_programming_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    replies: list[tuple[dict[str, object], str]] = [
        ({'asked_last': '2026-11-16', 'question_count': 1, 'tokens': 1}, 'the last question time'),
        ({'asked_last': None, 'question_count': '1', 'tokens': 1}, 'the question count'),
        ({'asked_last': None, 'question_count': 1, 'tokens': 1.5}, 'the token sum'),
    ]

    assert AccountQuestion.objects.all().totals() == (None, 0, 0)

    for reply, phrase in replies:
        aggregate_replied = partialmethod(_aggregate_replied, reply=reply)

        monkeypatch.setattr(AccountQuestionQuerySet, 'aggregate', aggregate_replied)

        with pytest.raises(TypeError, match=phrase):
            AccountQuestion.objects.all().totals()


def test_question_totals_add_up_the_questions_in_view() -> None:
    account = create_test_account()
    empty = account.questions.totals()

    for tokens in (100, 250, 4000):
        _ = _question_create(account, tokens=tokens)

    totals = account.questions.totals()
    newest = account.questions.order_by('-created_datetime').first()

    assert empty == (None, 0, 0)
    assert totals.question_count == 3
    assert totals.tokens == 4350
    assert newest is not None
    assert totals.asked_last == newest.created_datetime


def test_question_factory_refuses_an_unsaved_account_or_tokens_out_of_bounds() -> None:
    account = create_test_account()
    unsaved = type(account)(email='unsaved@example.com', name='Unsaved')
    message_unsaved = re.escape(f'account must be saved: {unsaved!r}')

    with pytest.raises(ValueError, match=message_unsaved):
        _ = _question_create(unsaved)

    for tokens in (0, -1, 1_000_001):
        with pytest.raises(ValueError, match=f'tokens must be 1 to 1000000: {tokens}'):
            AccountQuestion.services.factory.create(account=account, tokens=tokens)

    assert not AccountQuestion.objects.exists()

    for tokens in (1, QUESTION_TOKENS_MAX):
        _ = _question_create(account, tokens=tokens)

    assert account.questions.count() == 2


def test_question_factory_bound_to_a_saved_question_refuses_to_create_another() -> None:
    account = create_test_account()
    question = _question_create(account)
    message = re.escape(f'a question factory creates one question, and already holds {question!r}')

    with pytest.raises(RuntimeError, match=message):
        question.services.factory.create(account=account, tokens=10)

    assert AccountQuestion.objects.count() == 1
    assert question.tokens == 1000


@pytest.mark.django_db(transaction=True)
def test_question_factory_outside_a_transaction_is_a_programming_error() -> None:
    account = create_test_account()

    with pytest.raises(RuntimeError, match='inside the transaction that locked its account'):
        _ = _question_create(account)

    assert not AccountQuestion.objects.exists()

    with transaction.atomic():
        question = _question_create(account)

    assert question.account_id == account.pk


def test_question_saved_as_an_update_is_a_programming_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    account = create_test_account()
    save_original = AccountQuestionFactoryService.save_model_obj
    save_reported = partialmethod(_save_reported_as_update, save=save_original)

    assert not account.questions.exists()

    monkeypatch.setattr(AccountQuestionFactoryService, 'save_model_obj', save_reported)

    with pytest.raises(RuntimeError, match='was updated instead of created'):
        _ = _question_create(account)


def test_question_names_its_tokens_and_the_minute_it_was_asked() -> None:
    account = create_test_account()
    question = _question_create(account, tokens=1234)
    asked = question.created_datetime

    assert str(question) == f'1234 tokens asked {asked:%Y-%m-%d %H:%M}'
