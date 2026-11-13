from __future__ import annotations

import uuid

import pytest

from datetime import timedelta
from typing_extensions import TYPE_CHECKING

from django.urls import reverse
from django.utils import timezone

from app.account.constants import QUESTION_TOKENS_MAX
from app.account.ledger.choices import AccountLedgerEntryKindChoices
from app.account.ledger.models import AccountLedgerEntry
from app.account.models import Account
from app.account.question.models import AccountQuestion
from harness.api import (
    ACCOUNT_QUESTION_FINISH_PATH,
    ACCOUNT_QUESTION_PATH,
    account_create,
    api_post,
)

if TYPE_CHECKING:
    from django.test import Client
    from django.test.client import _MonkeyPatchedWSGIResponse

    from pytest_django.fixtures import Settings


pytestmark = pytest.mark.django_db
BURST_COUNT = 3
BURST_SECONDS = 600
PACE_SECONDS = 300
SECONDS_PER_DAY = 86_400
TOKENS_ESTIMATE = 1000
TOKENS_SOFT_CAP = 10_000
WINDOW_DAYS = 30
WINDOW_SECONDS = WINDOW_DAYS * SECONDS_PER_DAY


@pytest.fixture(autouse=True)
def ask_limited(settings: Settings) -> None:
    settings.REMI_ASK_BURST_COUNT = BURST_COUNT
    settings.REMI_ASK_BURST_SECONDS = BURST_SECONDS
    settings.REMI_ASK_PACE_SECONDS = PACE_SECONDS
    settings.REMI_ASK_TOKENS_ESTIMATE = TOKENS_ESTIMATE
    settings.REMI_ASK_TOKENS_SOFT_CAP = TOKENS_SOFT_CAP
    settings.REMI_ASK_WINDOW_DAYS = WINDOW_DAYS


def _account_active(client: Client, *, email: str = 'avery@example.com') -> tuple[Account, str]:
    token = account_create(client, email=email)
    account = Account.objects.get(email=email)

    _charge_aged(account, seconds=SECONDS_PER_DAY)

    return account, token


def _charge_aged(account: Account, *, seconds: float) -> None:
    entry = AccountLedgerEntry.objects.create(
        account=account,
        kind=AccountLedgerEntryKindChoices.CHARGE,
        reference=uuid.uuid4().hex,
        seconds=-60,
    )

    created = timezone.now() - timedelta(seconds=seconds)

    AccountLedgerEntry.objects.filter(pk=entry.pk).update(created_datetime=created)


def _question_aged(account: Account, *, seconds: float, tokens: int) -> None:
    question = AccountQuestion.objects.create(account=account, tokens=tokens)
    created = timezone.now() - timedelta(seconds=seconds)

    AccountQuestion.objects.filter(pk=question.pk).update(created_datetime=created)


def _question_finish(
    client: Client,
    token: str,
    *,
    question_id: object,
    tokens: object,
) -> _MonkeyPatchedWSGIResponse:
    body = {'question_id': question_id, 'tokens': tokens}

    return api_post(client, ACCOUNT_QUESTION_FINISH_PATH, body=body, token=token)


def test_a_question_needs_a_recording_processed_within_the_window(client: Client) -> None:
    token = account_create(client)
    account = Account.objects.get()
    refused = api_post(client, ACCOUNT_QUESTION_PATH, token=token)

    _charge_aged(account, seconds=WINDOW_SECONDS + 60)

    refused_old = api_post(client, ACCOUNT_QUESTION_PATH, token=token)

    _charge_aged(account, seconds=WINDOW_SECONDS - SECONDS_PER_DAY)

    started = api_post(client, ACCOUNT_QUESTION_PATH, token=token)
    question = AccountQuestion.objects.get()

    for response in (refused, refused_old):
        error = response.json()['error']

        assert response.status_code == 403
        assert error['code'] == 'ask_inactive'
        assert error['message'] == (
            'Ask answers questions for 30 days after each recording remi processes. '
            'Process a recording to keep asking.'
        )

    assert started.status_code == 200
    assert started.json() == {'notice': '', 'question_id': question.pk, 'wait_seconds': 0}
    assert question.account == account
    assert question.tokens == TOKENS_ESTIMATE
    assert question.finished_datetime is None


def test_a_question_is_finished_once_with_its_tokens_and_only_by_its_account(
    client: Client,
) -> None:
    _, token = _account_active(client)
    _, token_other = _account_active(client, email='morgan@example.com')
    question_id = api_post(client, ACCOUNT_QUESTION_PATH, token=token).json()['question_id']
    finished = _question_finish(client, token, question_id=question_id, tokens=2500)
    again = _question_finish(client, token, question_id=question_id, tokens=9999)
    question = AccountQuestion.objects.get()

    assert finished.status_code == 200
    assert finished.json() == {'question_id': question_id, 'tokens': 2500}
    assert again.json() == {'question_id': question_id, 'tokens': 2500}
    assert question.tokens == 2500
    assert question.finished_datetime is not None

    strangers = [
        _question_finish(client, token_other, question_id=question_id, tokens=10),
        _question_finish(client, token, question_id=question_id + 1000, tokens=10),
        _question_finish(client, token, question_id=0, tokens=10),
    ]

    for response in strangers:
        assert response.status_code == 404
        assert response.json()['error']['code'] == 'question_unknown'

    refused = [
        _question_finish(client, token, question_id=question_id, tokens=0),
        _question_finish(client, token, question_id=question_id, tokens=QUESTION_TOKENS_MAX + 1),
        _question_finish(client, token, question_id=question_id, tokens='2500'),
        _question_finish(client, token, question_id=str(question_id), tokens=2500),
    ]

    for response in refused:
        assert response.status_code == 400
        assert response.json()['error']['code'] == 'request_invalid'


def test_a_full_burst_tells_the_app_to_wait_and_records_no_question(client: Client) -> None:
    account, token = _account_active(client)

    for seconds in (30, 20, 10):
        _question_aged(account, seconds=seconds, tokens=TOKENS_ESTIMATE)

    response = api_post(client, ACCOUNT_QUESTION_PATH, token=token)
    started = response.json()
    wait_expected = BURST_SECONDS - 30

    assert response.status_code == 200
    assert started['question_id'] is None
    assert wait_expected - 2 <= started['wait_seconds'] <= wait_expected
    assert started['notice'].startswith('You have asked 3 questions in the last 10 minutes')
    assert AccountQuestion.objects.count() == BURST_COUNT


def test_past_the_soft_cap_questions_are_spaced_by_the_pace(client: Client) -> None:
    account, token = _account_active(client)

    _question_aged(account, seconds=60, tokens=TOKENS_SOFT_CAP)

    waiting = api_post(client, ACCOUNT_QUESTION_PATH, token=token).json()
    created = timezone.now() - timedelta(seconds=PACE_SECONDS + 1)

    AccountQuestion.objects.update(created_datetime=created)

    slow = api_post(client, ACCOUNT_QUESTION_PATH, token=token).json()
    wait_expected = PACE_SECONDS - 60

    assert waiting['question_id'] is None
    assert wait_expected - 2 <= waiting['wait_seconds'] <= wait_expected
    assert 'remi answers one question every 5 minutes. This answer starts' in waiting['notice']
    assert slow['question_id'] is not None
    assert slow['wait_seconds'] == 0
    assert slow['notice'] == (
        'You have asked a lot this month, so remi answers one question every 5 minutes.'
    )


def test_half_the_soft_cap_brings_a_heads_up_with_the_questions_left(client: Client) -> None:
    account, token = _account_active(client)

    for days in range(1, 6):
        _question_aged(account, seconds=days * SECONDS_PER_DAY, tokens=TOKENS_ESTIMATE)

    started = api_post(client, ACCOUNT_QUESTION_PATH, token=token).json()

    assert started['wait_seconds'] == 0
    assert started['notice'] == (
        "You have used half of this month's full-speed questions. About 5 are left before "
        'remi answers one every 5 minutes.'
    )


def test_questions_older_than_the_window_count_for_nothing(client: Client) -> None:
    account, token = _account_active(client)

    _question_aged(account, seconds=WINDOW_SECONDS + 60, tokens=50_000)

    started = api_post(client, ACCOUNT_QUESTION_PATH, token=token).json()

    assert started['wait_seconds'] == 0
    assert started['notice'] == ''
    assert started['question_id'] is not None


def test_a_question_recorded_ahead_of_the_clock_still_paces_from_it(client: Client) -> None:
    account, token = _account_active(client)

    _question_aged(account, seconds=-5, tokens=TOKENS_SOFT_CAP)

    started = api_post(client, ACCOUNT_QUESTION_PATH, token=token).json()

    assert started['question_id'] is None
    assert PACE_SECONDS - 2 <= started['wait_seconds'] <= PACE_SECONDS


def test_question_endpoints_need_a_signed_in_account(client: Client) -> None:
    body = {'question_id': 1, 'tokens': 1}
    started = api_post(client, ACCOUNT_QUESTION_PATH)
    finished = api_post(client, ACCOUNT_QUESTION_FINISH_PATH, body=body)

    assert started.status_code == 401
    assert finished.status_code == 401
    assert AccountQuestion.objects.count() == 0


def test_question_admin_lists_questions_and_changes_nothing(admin_client: Client) -> None:
    account, _ = _account_active(admin_client)

    _question_aged(account, seconds=300, tokens=1234)

    question = AccountQuestion.objects.get()
    body = {'tokens': 1}
    listed = admin_client.get(reverse('admin:account_question_accountquestion_changelist'))
    added = admin_client.get(reverse('admin:account_question_accountquestion_add'))
    url_change = reverse('admin:account_question_accountquestion_change', args=[question.pk])
    changed = admin_client.post(url_change, body)

    assert listed.status_code == 200
    assert b'avery@example.com' in listed.content
    assert added.status_code == 403
    assert changed.status_code == 403
    assert AccountQuestion.objects.get().tokens == 1234
