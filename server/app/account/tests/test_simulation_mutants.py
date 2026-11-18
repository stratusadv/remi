from __future__ import annotations

import pytest

from types import SimpleNamespace
from typing_extensions import TYPE_CHECKING

from django.db import transaction

from app.account.ledger.models import AccountLedgerEntry
from app.account.ledger.services.factory_service import (
    AccountLedgerEntryFactoryService,
    _metadata_integer,
)
from app.account.question import pace
from app.account.services.processor_service import AccountProcessorService
from app.account.tests.simulation_engine import RemiSimulation
from app.account.tests.simulation_scenarios import (
    FAULTS_DATABASE,
    simulate_concurrent,
    simulate_sequential,
    world_fresh,
)
from app.checkout.client import CHECKOUT_SESSION_PATTERN
from app.core.exceptions import BalanceInsufficientError
from app.core.querysets import BaseQuerySet
from app.funnel import mail as funnel_mail
from app.funnel import metric as funnel_metric
from harness.simulation.exceptions import SimulationFailureError

if TYPE_CHECKING:
    from collections.abc import Callable
    from datetime import datetime

    import stripe

    from app.account.tests.simulation_engine import RemiWorld


SEEDS_TRIED_MAX = 12

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.simulation]


def _charge_without_idempotency(
    service: AccountProcessorService,
    *,
    job_id: str,
    seconds: int,
) -> None:
    assert isinstance(service, AccountProcessorService)
    assert isinstance(job_id, str)
    assert isinstance(seconds, int)

    with transaction.atomic():
        account = service._account_locked()
        balance_seconds = account.ledger_entries.balance_seconds()

        if balance_seconds < seconds:
            message = 'the mutant refuses the charge'
            raise BalanceInsufficientError(message)

        AccountLedgerEntry.services.factory.charge_create(
            account=account,
            job_id=job_id,
            seconds=seconds,
        )


def _locked_not(queryset: BaseQuerySet) -> BaseQuerySet:
    assert queryset.query.where
    assert not queryset.query.select_for_update

    return queryset


def _on_commit_now(function: Callable[[], object]) -> None:
    assert callable(function)

    function()


def _purchase_without_payment_check(
    service: AccountLedgerEntryFactoryService,
    session: stripe.checkout.Session,
) -> bool:
    assert isinstance(service, AccountLedgerEntryFactoryService)
    assert CHECKOUT_SESSION_PATTERN.fullmatch(session.id) is not None

    metadata = {} if session.metadata is None else session.metadata.to_dict()

    if session.currency is None:
        message = f'checkout session {session.id} carries no currency'
        raise RuntimeError(message)

    if not isinstance(session.payment_intent, str | None):
        message = f'checkout session {session.id} carries an expanded payment intent'
        raise TypeError(message)

    service._purchase_create(
        account_id=_metadata_integer(metadata, 'account_id'),
        amount_cents=session.amount_total,
        currency=session.currency,
        payment_intent_id=session.payment_intent,
        seconds=_metadata_integer(metadata, 'seconds'),
        session_id=session.id,
    )

    return True


def _wait_burst_never(*, limits: pace.AskLimits, now: datetime, usage: pace.AskUsage) -> int:
    assert now.tzinfo is not None
    assert len(usage.asked_burst) <= limits.burst_count

    return 0


def _caught(
    world: RemiWorld,
    monkeypatch: pytest.MonkeyPatch,
    run_one: Callable[[int, RemiWorld], object],
) -> SimulationFailureError:
    assert world.faults is None

    for seed in range(SEEDS_TRIED_MAX):
        try:
            fresh = world_fresh(world, monkeypatch)
            run_one(seed, fresh)
        except SimulationFailureError as failure:
            return failure

    message = f'the mutant survived {SEEDS_TRIED_MAX} seeds'
    raise AssertionError(message)


def _sequential(seed: int, world: RemiWorld) -> object:
    assert 0 <= seed < SEEDS_TRIED_MAX
    assert world.faults is None

    run = simulate_sequential(seed, RemiSimulation(world))

    assert run.seed == seed

    return run


def _sequential_database_faults(seed: int, world: RemiWorld) -> object:
    assert 0 <= seed < SEEDS_TRIED_MAX
    assert world.faults is None

    world.faults = FAULTS_DATABASE
    run = simulate_sequential(seed, RemiSimulation(world))

    assert run.seed == seed

    return run


def test_simulation_catches_a_charge_taken_twice_for_one_recording(
    monkeypatch: pytest.MonkeyPatch,
    world: RemiWorld,
) -> None:
    monkeypatch.setattr(AccountProcessorService, 'charge', _charge_without_idempotency)

    failure = _caught(world, monkeypatch, _sequential)

    assert failure.seed < SEEDS_TRIED_MAX
    assert 'charge' in str(failure)


def test_simulation_catches_an_unpaid_session_credited(
    monkeypatch: pytest.MonkeyPatch,
    world: RemiWorld,
) -> None:
    monkeypatch.setattr(
        AccountLedgerEntryFactoryService,
        'purchase_from_checkout',
        _purchase_without_payment_check,
    )

    failure = _caught(world, monkeypatch, _sequential)

    assert failure.seed < SEEDS_TRIED_MAX
    assert 'finish' in str(failure) or 'webhook' in str(failure) or 'drifted' in str(failure)


def test_simulation_catches_an_email_window_that_holds_nothing(
    monkeypatch: pytest.MonkeyPatch,
    world: RemiWorld,
) -> None:
    monkeypatch.setattr(funnel_mail, 'FUNNEL_EMAIL_ADDRESS_WINDOW_SECONDS', 0)

    failure = _caught(world, monkeypatch, _sequential)

    assert failure.seed < SEEDS_TRIED_MAX
    assert 'email' in str(failure)


def test_simulation_catches_a_burst_that_lets_every_question_through(
    monkeypatch: pytest.MonkeyPatch,
    world: RemiWorld,
) -> None:
    monkeypatch.setattr(pace, '_wait_burst_seconds', _wait_burst_never)

    failure = _caught(world, monkeypatch, _sequential)

    assert failure.seed < SEEDS_TRIED_MAX
    assert 'in one burst' in str(failure)


def test_simulation_catches_metrics_sent_before_their_transaction_commits(
    monkeypatch: pytest.MonkeyPatch,
    world: RemiWorld,
) -> None:
    transaction_eager = SimpleNamespace(on_commit=_on_commit_now)

    monkeypatch.setattr(funnel_metric, 'transaction', transaction_eager)

    failure = _caught(world, monkeypatch, _sequential_database_faults)

    assert failure.seed < SEEDS_TRIED_MAX
    assert 'metric' in str(failure)


def test_simulation_catches_writes_that_skip_the_account_lock(
    monkeypatch: pytest.MonkeyPatch,
    world: RemiWorld,
) -> None:
    monkeypatch.setattr(BaseQuerySet, 'locked', _locked_not)

    failure = _caught(world, monkeypatch, simulate_concurrent)

    assert failure.seed < SEEDS_TRIED_MAX
    assert 'serial order' in str(failure) or 'concurrent actors raised' in str(failure)
