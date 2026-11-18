from __future__ import annotations

import random
import re
import uuid

import pytest

from datetime import UTC, datetime
from fractions import Fraction
from functools import partialmethod
from typing_extensions import TYPE_CHECKING

from app.account.constants import (
    SECONDS_PER_HOUR,
    SECONDS_PER_MINUTE,
    TENTHS_PER_HOUR,
    TOPUP_BALANCE_SECONDS,
)
from app.account.ledger.choices import AccountLedgerEntryKindChoices
from app.account.ledger.models import AccountLedgerEntry
from app.account.ledger.services.factory_service import AccountLedgerEntryFactoryService
from app.account.question.pace import AskLimits, AskUsage
from app.account.services import processor_service
from app.account.tests.factories import create_test_account
from app.core.exceptions import PromoInvalidError, QuestionUnknownError, RequestInvalidError

if TYPE_CHECKING:
    from collections.abc import Callable

    from app.account.models import Account


pytestmark = pytest.mark.django_db
DURATION_SAMPLES = 400
JOB_ID = '86dfb1d3b0140ecf2fd59075421f1cb5'
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


class QuotientFloorWrong(int):
    def __floordiv__(self, divisor: int) -> int:
        assert divisor > 0

        return 0


def _balance_negative(account: Account) -> None:
    AccountLedgerEntry.objects.create(
        account=account,
        kind=AccountLedgerEntryKindChoices.CHARGE,
        reference=uuid.uuid4().hex,
        seconds=-60,
    )

    assert account.ledger_entries.balance_seconds() < 0


def _charge_short(
    service: AccountLedgerEntryFactoryService,
    *,
    account: Account,
    job_id: str,
    seconds: int,
    charge_create: Callable[..., None],
) -> None:
    assert service.model_obj_is_new
    assert len(job_id) == len(JOB_ID)
    assert seconds > 1

    charge_create(service, account=account, job_id=job_id, seconds=seconds - 1)


def _duration_parsed(text: str) -> Fraction:
    assert re.fullmatch(r'\d+(\.\d)? (minutes?|hours?)', text), text

    amount, unit = text.split(' ')

    if unit.startswith('minute'):
        seconds = Fraction(int(amount) * SECONDS_PER_MINUTE)

        assert seconds <= SECONDS_PER_HOUR, text

        return seconds

    seconds = Fraction(amount) * SECONDS_PER_HOUR

    assert seconds >= SECONDS_PER_HOUR, text

    return seconds


def _grant_short(
    service: AccountLedgerEntryFactoryService,
    *,
    account: Account,
    reference: str,
    seconds: int,
    grant_create: Callable[..., None],
) -> None:
    assert service.model_obj_is_new
    assert reference.startswith('topup:')
    assert seconds > 1

    grant_create(service, account=account, reference=reference, seconds=seconds - 1)


def test_duration_text_reads_whole_minutes_under_an_hour_and_tenths_above() -> None:
    examples = [
        (0, False, '0 minutes'),
        (59, False, '0 minutes'),
        (59, True, '1 minute'),
        (60, False, '1 minute'),
        (61, True, '2 minutes'),
        (3599, False, '59 minutes'),
        (3599, True, '60 minutes'),
        (3600, False, '1 hour'),
        (3600, True, '1 hour'),
        (3601, True, '1.1 hours'),
        (3601, False, '1 hour'),
        (7199, False, '1.9 hours'),
        (7200, True, '2 hours'),
        (36_000, False, '10 hours'),
    ]

    for seconds, rounded_up, expected in examples:
        shown = processor_service._duration_text(seconds, rounded_up=rounded_up)

        assert shown == expected, (seconds, rounded_up)


def test_duration_text_rounds_the_way_it_is_asked_and_by_less_than_one_unit() -> None:
    generator = random.Random(2026)

    for _ in range(DURATION_SAMPLES):
        seconds = generator.randint(0, 30 * SECONDS_PER_HOUR)
        step = SECONDS_PER_MINUTE

        if seconds >= SECONDS_PER_HOUR:
            step = SECONDS_PER_HOUR // TENTHS_PER_HOUR

        up = _duration_parsed(processor_service._duration_text(seconds, rounded_up=True))
        down = _duration_parsed(processor_service._duration_text(seconds, rounded_up=False))

        assert seconds <= up < seconds + step, seconds
        assert seconds - step < down <= seconds, seconds


def test_duration_and_quotient_refuse_negative_or_zero_inputs() -> None:
    assert processor_service._duration_text(0, rounded_up=True) == '0 minutes'
    assert processor_service._quotient(dividend=0, divisor=60, rounded_up=True) == 0
    assert processor_service._quotient(dividend=60, divisor=1, rounded_up=False) == 60

    with pytest.raises(ValueError, match='seconds must be non-negative: -1'):
        processor_service._duration_text(-1, rounded_up=False)

    with pytest.raises(ValueError, match='dividend must be non-negative: -1'):
        processor_service._quotient(dividend=-1, divisor=60, rounded_up=False)

    for divisor in (0, -60):
        with pytest.raises(ValueError, match=f'divisor must be positive: {divisor}'):
            processor_service._quotient(dividend=60, divisor=divisor, rounded_up=False)


def test_quotient_a_whole_step_from_the_exact_value_is_a_programming_error() -> None:
    dividend = QuotientFloorWrong(10)
    message = f'{dividend} / 3 rounded to 0, a whole step'

    assert processor_service._quotient(dividend=int(dividend), divisor=3, rounded_up=False) == 3

    with pytest.raises(RuntimeError, match=message):
        processor_service._quotient(dividend=dividend, divisor=3, rounded_up=False)


def test_ask_usage_refuses_a_clock_without_a_zone_or_an_empty_burst() -> None:
    account = create_test_account()
    limits_empty = LIMITS._replace(burst_count=0)
    message = f'the burst must hold at least one question: {limits_empty.burst_count}'

    with pytest.raises(ValueError, match='now must carry a time zone'):
        processor_service._ask_usage(account=account, limits=LIMITS, now=NOW_NAIVE)

    with pytest.raises(ValueError, match=message):
        processor_service._ask_usage(account=account, limits=limits_empty, now=NOW)

    limits_one = LIMITS._replace(burst_count=1)
    usage_empty = AskUsage(asked_burst=(), asked_last=None, question_count=0, tokens=0)
    now, usage = processor_service._ask_usage(account=account, limits=limits_one, now=NOW)

    assert now == NOW
    assert usage == usage_empty


def test_ask_usage_of_an_account_that_never_asked_is_empty() -> None:
    account = create_test_account()
    now, usage = processor_service._ask_usage(account=account, limits=LIMITS, now=NOW)

    assert now == NOW
    assert usage.asked_burst == ()
    assert usage.asked_last is None
    assert usage.question_count == 0
    assert usage.tokens == 0


def test_a_ledger_gone_negative_stops_a_charge_and_a_topup() -> None:
    account = create_test_account()

    _balance_negative(account)

    with pytest.raises(RuntimeError, match=f'account {account.pk} holds -60 seconds'):
        account.services.processor.charge(job_id=JOB_ID, seconds=60)

    with pytest.raises(RuntimeError, match=f'account {account.pk} holds -60 seconds'):
        account.services.processor.balance_topup(reference='topup:test:1')

    assert account.ledger_entries.balance_seconds() == -60
    assert account.ledger_entries.count() == 1


def test_a_charge_that_moves_the_balance_by_the_wrong_amount_is_rolled_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    account = create_test_account(seconds=SECONDS_PER_HOUR)
    charge_original = AccountLedgerEntryFactoryService.charge_create
    charge_short = partialmethod(_charge_short, charge_create=charge_original)

    monkeypatch.setattr(AccountLedgerEntryFactoryService, 'charge_create', charge_short)

    with pytest.raises(RuntimeError, match='moved its balance from 3600 to 3001'):
        account.services.processor.charge(job_id=JOB_ID, seconds=600)

    assert account.ledger_entries.balance_seconds() == SECONDS_PER_HOUR
    assert not account.ledger_entries.charges().exists()


def test_a_topup_that_misses_the_target_is_rolled_back(monkeypatch: pytest.MonkeyPatch) -> None:
    account = create_test_account(seconds=SECONDS_PER_HOUR)
    grant_original = AccountLedgerEntryFactoryService.grant_create
    grant_short = partialmethod(_grant_short, grant_create=grant_original)

    monkeypatch.setattr(AccountLedgerEntryFactoryService, 'grant_create', grant_short)

    expected = f'was topped up to {TOPUP_BALANCE_SECONDS - 1} seconds'

    with pytest.raises(RuntimeError, match=expected):
        account.services.processor.balance_topup(reference='topup:test:1')

    assert account.ledger_entries.balance_seconds() == SECONDS_PER_HOUR
    assert not account.ledger_entries.grants().exists()


def test_question_finish_refuses_an_id_or_token_count_out_of_range() -> None:
    account = create_test_account()

    for question_id in (0, -1):
        with pytest.raises(QuestionUnknownError, match='not one this account asked'):
            account.services.processor.question_finish(question_id=question_id, tokens=5)

    for tokens in (0, -5, 1_000_001):
        with pytest.raises(RequestInvalidError, match=f'not {tokens}'):
            account.services.processor.question_finish(question_id=1, tokens=tokens)

    assert not account.questions.exists()


def test_promo_redeem_refuses_a_blank_or_overlong_code_without_locking() -> None:
    account = create_test_account()

    with pytest.raises(PromoInvalidError, match=re.escape('Enter a promo code.')):
        account.services.processor.promo_redeem('   ')

    with pytest.raises(PromoInvalidError, match='at most 64 characters'):
        account.services.processor.promo_redeem('P' * 65)

    assert not account.ledger_entries.exists()


def test_token_issue_replaces_the_stored_digest_and_returns_the_new_token() -> None:
    account = create_test_account()
    digest_before = account.token_hash
    token = account.services.processor.token_issue()
    account.refresh_from_db()

    assert account.token_hash != digest_before
    assert account.token_hash == processor_service.token_hash(token)


def test_complimentary_end_on_an_unsaved_account_is_a_programming_error() -> None:
    account = create_test_account()
    unsaved = type(account)(email='unsaved@example.com', name='Unsaved')
    message = re.escape(f'the account must be saved: {unsaved!r}')

    with pytest.raises(ValueError, match=message):
        unsaved.services.processor.complimentary_end()

    assert not type(account).objects.complimentary().exists()
