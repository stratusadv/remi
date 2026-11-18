from __future__ import annotations

import threading

import pytest

from functools import partial, partialmethod
from typing_extensions import TYPE_CHECKING

from django.db import connection

from app.account.constants import QUESTION_TOKENS_MAX, SECONDS_PER_HOUR
from app.account.question.models import AccountQuestion
from app.account.question.services.factory_service import AccountQuestionFactoryService
from app.account.tests.factories import create_test_account

if TYPE_CHECKING:
    from collections.abc import Callable

    from pytest_django.fixtures import Settings

    from app.account.models import Account


JOB_ID = '86dfb1d3b0140ecf2fd59075421f1cb5'
LOCK_HOLD_SECONDS = 1.0
THREAD_WAIT_SECONDS = 10.0


def _ask_thread(
    account: Account,
    *,
    done_second: threading.Event,
    outcomes: dict[str, tuple[bool, bool]],
) -> None:
    name = threading.current_thread().name

    assert name in ('first', 'second')
    assert name not in outcomes
    assert not done_second.is_set()

    try:
        question, pace = account.services.processor.question_start()
        outcomes[name] = (question is not None, pace.wait_seconds > 0)
    finally:
        if name == 'second':
            done_second.set()

        connection.close()


def _create_pausing(
    service: AccountQuestionFactoryService,
    *,
    account: Account,
    created_first: threading.Event,
    done_second: threading.Event,
    tokens: int,
    create: Callable[..., AccountQuestion],
) -> AccountQuestion:
    assert service.model_obj_is_new
    assert not created_first.is_set()
    assert not done_second.is_set()
    assert 0 < tokens <= QUESTION_TOKENS_MAX

    question = create(service, account=account, tokens=tokens)

    if threading.current_thread().name == 'first':
        created_first.set()
        waited = done_second.wait(timeout=LOCK_HOLD_SECONDS)

        assert not waited

    return question


@pytest.mark.django_db(transaction=True)
def test_two_questions_racing_for_the_last_place_in_a_burst_admit_one(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
) -> None:
    settings.REMI_ASK_BURST_COUNT = 1
    settings.REMI_ASK_BURST_SECONDS = 600

    account = create_test_account(seconds=SECONDS_PER_HOUR)

    account.services.processor.charge(job_id=JOB_ID, seconds=60)

    created_first = threading.Event()
    done_second = threading.Event()
    outcomes = {}
    create_original = AccountQuestionFactoryService.create

    create_pausing = partialmethod(
        _create_pausing,
        created_first=created_first,
        done_second=done_second,
        create=create_original,
    )

    ask = partial(_ask_thread, account, done_second=done_second, outcomes=outcomes)

    monkeypatch.setattr(AccountQuestionFactoryService, 'create', create_pausing)

    first = threading.Thread(target=ask, name='first')
    second = threading.Thread(target=ask, name='second')

    first.start()

    waited = created_first.wait(timeout=THREAD_WAIT_SECONDS)

    assert waited

    second.start()
    first.join(timeout=THREAD_WAIT_SECONDS)
    second.join(timeout=THREAD_WAIT_SECONDS)
    monkeypatch.undo()

    assert outcomes == {'first': (True, False), 'second': (False, True)}
    assert AccountQuestion.objects.count() == 1
