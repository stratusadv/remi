from __future__ import annotations

import hashlib
import random
import re
import threading

import pytest

from typing_extensions import TYPE_CHECKING

from django.db import connection, transaction

from app.account.constants import (
    CHARGE_SECONDS_MAX,
    SECONDS_PER_HOUR,
    SECONDS_PER_MINUTE,
    TOPUP_BALANCE_SECONDS,
)
from app.account.ledger.models import AccountLedgerEntry
from app.account.ledger.querysets import AccountLedgerEntryQuerySet
from app.account.models import Account
from app.account.tests.factories import create_test_account
from app.core.exceptions import BalanceInsufficientError
from app.funnel.choices import CampaignChoices
from app.promo_code.tests.factories import create_test_promo_code
from harness.api import ACCOUNT_CHARGE_PATH, account_create, account_get, api_post

if TYPE_CHECKING:
    from pytest_django.fixtures import DjangoCaptureOnCommitCallbacks

    from django.test import Client

    from harness.metric import MetricExecutorFake


pytestmark = pytest.mark.django_db
BALANCE_MESSAGE_SAMPLES = 60
JOB_ID_FIRST = '86dfb1d3b0140ecf2fd59075421f1cb5'
JOB_ID_SECOND = '47ead100cc5cd956aa10b3c4d5e6f708'
LOCK_HOLD_SECONDS = 1.0
SECONDS_PER_HOUR_TENTH = 360
THREAD_WAIT_SECONDS = 10.0

BALANCE_MESSAGE_PATTERN = re.compile(
    r'needs (?P<needed>\d+(?:\.\d)?) (?P<needed_unit>minutes?|hours?) of transcription and the '
    r'account has (?P<held>\d+(?:\.\d)?) (?P<held_unit>minutes?|hours?) left\.',
)


def _charge_refusal(*, held: int, needed: int, email: str) -> str:
    account = create_test_account(email=email, seconds=held)

    with pytest.raises(BalanceInsufficientError) as caught:
        account.services.processor.charge(job_id=JOB_ID_FIRST, seconds=needed)

    assert not account.ledger_entries.charges().exists()

    return str(caught.value)


def _duration_seconds(*, amount: str, unit: str) -> int:
    if unit.startswith('minute'):
        return int(amount) * SECONDS_PER_MINUTE

    whole, _, tenth = amount.partition('.')
    tenths = int(whole) * 10 + int(tenth or '0')

    return tenths * SECONDS_PER_HOUR_TENTH


def _duration_step(seconds: int) -> int:
    if seconds < SECONDS_PER_HOUR:
        return SECONDS_PER_MINUTE

    return SECONDS_PER_HOUR_TENTH


def test_balance_topup_after_a_charge_grants_back_exactly_the_charge() -> None:
    account = create_test_account(email='topup@example.com')

    _ = account.services.processor.balance_topup(reference='topup:test:1')

    account.services.processor.charge(job_id=JOB_ID_FIRST, seconds=SECONDS_PER_HOUR)

    granted = account.services.processor.balance_topup(reference='topup:test:2')

    assert granted == SECONDS_PER_HOUR
    assert account.ledger_entries.balance_seconds() == TOPUP_BALANCE_SECONDS
    assert account.ledger_entries.grants().count() == 2


def test_balance_topup_grants_the_shortfall_and_nothing_once_the_target_is_held() -> None:
    account = create_test_account(email='topup@example.com', seconds=10 * SECONDS_PER_HOUR)
    granted = account.services.processor.balance_topup(reference='topup:test:1')
    granted_again = account.services.processor.balance_topup(reference='topup:test:2')
    grants = list(account.ledger_entries.grants().values_list('seconds', flat=True))

    assert granted == TOPUP_BALANCE_SECONDS - 10 * SECONDS_PER_HOUR
    assert granted_again == 0
    assert grants == [granted]
    assert account.ledger_entries.balance_seconds() == TOPUP_BALANCE_SECONDS


def test_balance_topup_records_no_metric_and_counts_as_no_purchase_or_promo(
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
    metric_dispatched: MetricExecutorFake,
) -> None:
    account = create_test_account(email='topup@example.com')

    with django_capture_on_commit_callbacks(execute=True):
        granted = account.services.processor.balance_topup(reference='topup:test:1')

    assert granted == TOPUP_BALANCE_SECONDS
    assert metric_dispatched.statistic_keys() == []
    assert not account.ledger_entries.purchases().exists()
    assert not account.ledger_entries.promos().exists()


def test_charge_beyond_the_balance_is_refused_without_a_ledger_entry(client: Client) -> None:
    create_test_promo_code(code='ONE', hours=1)

    token = account_create(client, promo_code='ONE')
    body = {'job_id': JOB_ID_FIRST, 'seconds': SECONDS_PER_HOUR + 1}
    response = api_post(client, ACCOUNT_CHARGE_PATH, body=body, token=token)

    assert response.status_code == 402
    assert response.json()['error']['code'] == 'balance_insufficient'
    assert AccountLedgerEntry.objects.charges().count() == 0
    assert account_get(client, token)['balance_seconds'] == SECONDS_PER_HOUR


def test_charge_on_an_unsaved_account_is_a_programming_error() -> None:
    unsaved = Account(email='unsaved@example.com', name='Unsaved')

    assert unsaved.pk is None

    with pytest.raises(ValueError, match='must be saved'):
        unsaved.services.processor.charge(job_id=JOB_ID_FIRST, seconds=1)

    assert AccountLedgerEntry.objects.count() == 0


def test_charge_refusal_never_overstates_the_balance_or_understates_the_need() -> None:
    generator = random.Random(2026)

    pairs = [
        (1, 0),
        (60, 59),
        (61, 60),
        (3599, 3540),
        (3600, 3599),
        (3601, 3600),
        (CHARGE_SECONDS_MAX, CHARGE_SECONDS_MAX - 1),
    ]

    for _ in range(BALANCE_MESSAGE_SAMPLES):
        needed = generator.randint(1, CHARGE_SECONDS_MAX)
        pair = (needed, generator.randint(0, needed - 1))
        pairs.append(pair)

    for index, (needed, held) in enumerate(pairs):
        message = _charge_refusal(held=held, needed=needed, email=f'round{index}@example.com')
        match = BALANCE_MESSAGE_PATTERN.search(message)

        assert match is not None, message

        shown_needed = _duration_seconds(amount=match['needed'], unit=match['needed_unit'])
        shown_held = _duration_seconds(amount=match['held'], unit=match['held_unit'])
        context = f'needed {needed}, held {held}: {message}'

        assert needed <= shown_needed < needed + _duration_step(needed), context
        assert held - _duration_step(held) < shown_held <= held, context
        assert shown_held < shown_needed, context


def test_charge_refusal_states_short_amounts_in_minutes_and_long_ones_in_hours() -> None:
    short = _charge_refusal(held=0, needed=144, email='short@example.com')
    edge = _charge_refusal(held=3600, needed=3601, email='edge@example.com')

    assert short == (
        'This recording needs 3 minutes of transcription and the account has 0 minutes left. '
        'Buy more hours to transcribe it.'
    )

    assert edge == (
        'This recording needs 1.1 hours of transcription and the account has 1 hour left. '
        'Buy more hours to transcribe it.'
    )


def test_charge_repeated_for_the_same_job_is_taken_once(client: Client) -> None:
    create_test_promo_code(code='ONE', hours=1)

    token = account_create(client, promo_code='ONE')
    body = {'job_id': JOB_ID_FIRST, 'seconds': 600}

    for _ in range(3):
        response = api_post(client, ACCOUNT_CHARGE_PATH, body=body, token=token)

        assert response.status_code == 200
        assert response.json()['balance_seconds'] == SECONDS_PER_HOUR - 600

    assert AccountLedgerEntry.objects.charges().count() == 1


def test_charge_with_a_bad_job_id_or_duration_is_refused(client: Client) -> None:
    create_test_promo_code(code='ONE', hours=1)

    token = account_create(client, promo_code='ONE')

    bodies = [
        {'job_id': 'short', 'seconds': 10},
        {'job_id': JOB_ID_FIRST.upper(), 'seconds': 10},
        {'job_id': JOB_ID_FIRST, 'seconds': 0},
        {'job_id': JOB_ID_FIRST, 'seconds': -5},
        {'job_id': JOB_ID_FIRST, 'seconds': True},
        {'job_id': JOB_ID_FIRST, 'seconds': 10.5},
        {'job_id': JOB_ID_FIRST, 'seconds': '10'},
        {'job_id': JOB_ID_FIRST, 'seconds': CHARGE_SECONDS_MAX + 1},
        {'job_id': JOB_ID_FIRST},
        {'seconds': 10},
        [JOB_ID_FIRST, 10],
    ]

    for body in bodies:
        response = api_post(client, ACCOUNT_CHARGE_PATH, body=body, token=token)

        assert response.status_code == 400, body
        assert response.json()['error']['code'] == 'request_invalid', body

    assert account_get(client, token)['balance_seconds'] == SECONDS_PER_HOUR


def test_code_issued_from_a_stale_copy_keeps_a_campaign_set_meanwhile() -> None:
    create_test_promo_code(campaign=CampaignChoices.WIB, code='WIB2026')

    account = create_test_account()
    stale = Account.objects.get(pk=account.pk)

    account.services.processor.promo_redeem('WIB2026')

    token = stale.services.processor.token_issue()
    stored = Account.objects.get(pk=account.pk)

    assert stale.campaign == CampaignChoices.GENERAL
    assert stored.campaign == CampaignChoices.WIB
    assert stored.token_hash == hashlib.sha256(token.encode()).hexdigest()


@pytest.mark.django_db(transaction=True)
def test_lock_makes_a_second_charge_wait_for_the_first(monkeypatch: pytest.MonkeyPatch) -> None:
    account = create_test_account(email='lock@example.com', seconds=SECONDS_PER_HOUR)
    read_first = threading.Event()
    done_second = threading.Event()
    outcomes = {}
    balance_seconds_original = AccountLedgerEntryQuerySet.balance_seconds

    def balance_seconds_pausing(queryset: AccountLedgerEntryQuerySet) -> int:
        balance = balance_seconds_original(queryset)

        if threading.current_thread().name == 'first':
            if not read_first.is_set():
                read_first.set()
                done_second.wait(timeout=LOCK_HOLD_SECONDS)

        return balance

    def charge(job_id: str) -> None:
        name = threading.current_thread().name

        try:
            account.services.processor.charge(job_id=job_id, seconds=SECONDS_PER_HOUR)
        except BalanceInsufficientError:
            outcomes[name] = 'insufficient'
        else:
            outcomes[name] = 'charged'
        finally:
            if name == 'second':
                done_second.set()

            connection.close()

    monkeypatch.setattr(AccountLedgerEntryQuerySet, 'balance_seconds', balance_seconds_pausing)

    first = threading.Thread(target=charge, args=(JOB_ID_FIRST,), name='first')
    second = threading.Thread(target=charge, args=(JOB_ID_SECOND,), name='second')

    first.start()

    assert read_first.wait(timeout=THREAD_WAIT_SECONDS)

    second.start()
    first.join(timeout=THREAD_WAIT_SECONDS)
    second.join(timeout=THREAD_WAIT_SECONDS)
    monkeypatch.undo()

    assert outcomes == {'first': 'charged', 'second': 'insufficient'}
    assert account.ledger_entries.balance_seconds() == 0


@pytest.mark.django_db(transaction=True)
def test_lock_makes_a_second_topup_grant_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    account = create_test_account(email='lock@example.com', seconds=SECONDS_PER_HOUR)
    read_first = threading.Event()
    done_second = threading.Event()
    granted = {}
    balance_seconds_original = AccountLedgerEntryQuerySet.balance_seconds

    def balance_seconds_pausing(queryset: AccountLedgerEntryQuerySet) -> int:
        balance = balance_seconds_original(queryset)

        if threading.current_thread().name == 'first':
            if not read_first.is_set():
                read_first.set()
                done_second.wait(timeout=LOCK_HOLD_SECONDS)

        return balance

    def topup(reference: str) -> None:
        name = threading.current_thread().name

        try:
            granted[name] = account.services.processor.balance_topup(reference=reference)
        finally:
            if name == 'second':
                done_second.set()

            connection.close()

    monkeypatch.setattr(AccountLedgerEntryQuerySet, 'balance_seconds', balance_seconds_pausing)

    first = threading.Thread(target=topup, args=('topup:first',), name='first')
    second = threading.Thread(target=topup, args=('topup:second',), name='second')

    first.start()

    assert read_first.wait(timeout=THREAD_WAIT_SECONDS)

    second.start()
    first.join(timeout=THREAD_WAIT_SECONDS)
    second.join(timeout=THREAD_WAIT_SECONDS)
    monkeypatch.undo()

    assert granted == {'first': TOPUP_BALANCE_SECONDS - SECONDS_PER_HOUR, 'second': 0}
    assert account.ledger_entries.balance_seconds() == TOPUP_BALANCE_SECONDS


@pytest.mark.django_db(transaction=True)
def test_lock_taken_outside_a_transaction_is_a_programming_error() -> None:
    assert not transaction.get_connection().in_atomic_block

    with pytest.raises(RuntimeError, match='inside the transaction'):
        create_test_account().services.processor._account_locked()


def test_promo_redeemed_from_a_stale_copy_keeps_a_code_issued_meanwhile() -> None:
    create_test_promo_code(campaign=CampaignChoices.WIB, code='WIB2026')

    account = create_test_account()
    stale = Account.objects.get(pk=account.pk)
    token = account.services.processor.token_issue()
    redeemed = stale.services.processor.promo_redeem('WIB2026')
    stored = Account.objects.get(pk=account.pk)

    assert redeemed.campaign == CampaignChoices.WIB
    assert stored.token_hash == hashlib.sha256(token.encode()).hexdigest()
    assert stored.ledger_entries.balance_seconds() == 250 * SECONDS_PER_HOUR
