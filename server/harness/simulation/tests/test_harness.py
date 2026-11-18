from __future__ import annotations

import functools
import random
import time

import pytest

from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from django.db import connection, transaction
from django.utils import timezone

from app.account.models import Account
from app.account.tests.factories import create_test_account
from harness.simulation import pytest_plugin
from harness.simulation.clock import ADVANCE_SECONDS_MAX, Clock
from harness.simulation.exceptions import (
    SimulationBoundsError,
    SimulationDatabaseFaultError,
    SimulationError,
    SimulationFailureError,
    SimulationInvariantError,
)
from harness.simulation.fault import Faults, NetworkFate, database_faults_installed
from harness.simulation.interleaver import Interleaver
from harness.simulation.invariant import invariant_violated, rows_clean
from harness.simulation.run import Run, Scenario, Timeline, simulate
from harness.simulation.scheduler import FIRES_PER_ADVANCE_MAX, Job, Scheduler
from harness.simulation.swarm import swarm_names_of, swarmed


CADENCE_STEP_COUNT = 12
FATE_SAMPLES = 2000
SCENARIO_EMPTY = Scenario(actions=(), invariants=())
START = datetime(2026, 11, 16, 8, 0, tzinfo=UTC)


@dataclass
class _Cadence:
    checks: list[int] = field(default_factory=list)
    chosen: list[str] = field(default_factory=list)

    def invariant(self, run: Run) -> None:
        assert 0 <= run.step < CADENCE_STEP_COUNT

        self.checks.append(run.step)

    def tick(self, run: Run) -> None:
        assert 0 <= run.step < CADENCE_STEP_COUNT

        self.chosen.append('tick')
        run.sometimes('ticked')

    def tock(self, run: Run) -> None:
        assert 0 <= run.step < CADENCE_STEP_COUNT

        self.chosen.append('tock')
        run.sometimes('tocked', condition=run.step > 100)


def _actor_failing(*, account: Account) -> None:
    assert account.pk is not None

    Account.objects.filter(pk=account.pk).exists()

    message = 'the actor broke'
    raise ValueError(message)


def _actor_run(*, account: Account, log: list[str], name: str) -> str:
    assert isinstance(log, list)
    assert name in ('first', 'second')

    for _ in range(3):
        log.append(name)
        Account.objects.filter(pk=account.pk).exists()

    return name


def _fail_at_five(run: Run) -> None:
    assert run.step <= 5

    run.log('working')

    if run.step == 5:
        invariant_violated('the books do not balance')


def _failure_of(scenario: Scenario, *, seed: int) -> SimulationFailureError:
    assert isinstance(scenario, Scenario)
    assert isinstance(seed, int)

    with pytest.raises(SimulationFailureError) as caught:
        simulate(scenario, _timeline(), seed=seed)

    return caught.value


def _idle(run: Run) -> None:
    _ = run


def _interleaving_order(account: Account, *, seed: int) -> tuple[str, ...]:
    assert isinstance(seed, int)

    log: list[str] = []
    first = functools.partial(_actor_run, account=account, log=log, name='first')
    second = functools.partial(_actor_run, account=account, log=log, name='second')
    failing = functools.partial(_actor_failing, account=account)
    actions = [first, second, failing]
    results, errors = Interleaver(random.Random(seed), actions).drive()

    assert results == {0: 'first', 1: 'second'}
    assert list(errors) == [2]
    assert str(errors[2]) == 'the actor broke'

    return tuple(log)


def _timeline(*, step_count: int = 10, checkpoint_every: int = 1) -> Timeline:
    assert isinstance(step_count, int)
    assert isinstance(checkpoint_every, int)

    return Timeline(
        checkpoint_every=checkpoint_every,
        start=START,
        step_count=step_count,
        step_seconds=60,
    )


def test_clock_moves_wall_time_and_django_time_together_and_only_forward() -> None:
    real_before = timezone.now()

    with Clock(START) as clock:
        before = time.time()

        clock.advance(3600)

        assert clock.now() == START + timedelta(hours=1)
        assert timezone.now() == START + timedelta(hours=1)
        assert time.time() - before == 3600

        for seconds in (0, -1, ADVANCE_SECONDS_MAX + 1):
            with pytest.raises(SimulationBoundsError, match='clock advance'):
                clock.advance(seconds)

    assert abs(timezone.now() - real_before) < timedelta(minutes=1)


def test_clock_refuses_a_naive_start_and_use_outside_its_context() -> None:
    clock = Clock(START)

    with pytest.raises(SimulationBoundsError, match='must carry a time zone'):
        Clock(START.replace(tzinfo=None))

    with pytest.raises(SimulationError, match='advanced outside its context'):
        clock.advance(1)

    with pytest.raises(SimulationError, match='read outside its context'):
        clock.now()


def test_scheduler_fires_each_job_once_per_period_it_crosses() -> None:
    fired: list[str] = []
    hourly = functools.partial(fired.append, 'hourly')
    daily = functools.partial(fired.append, 'daily')
    jobs = [Job(every_seconds=3600, method=hourly), Job(every_seconds=86_400, method=daily)]
    scheduler = Scheduler(jobs, START)

    fired_through_minute_59 = scheduler.advance_to(START + timedelta(minutes=59))

    assert fired_through_minute_59 == []

    fired_through_hour_3 = scheduler.advance_to(START + timedelta(hours=3))

    assert len(fired_through_hour_3) == 3

    fired_through_day_1 = scheduler.advance_to(START + timedelta(days=1))

    assert len(fired_through_day_1) == 22
    assert Counter(fired) == {'hourly': 24, 'daily': 1}


def test_scheduler_refuses_bad_jobs_and_a_runaway_catch_up() -> None:
    runs = []
    job = functools.partial(runs.append, 'job')

    with pytest.raises(SimulationBoundsError, match='every_seconds must be at least one'):
        Scheduler([Job(every_seconds=0, method=job)], START)

    scheduler = Scheduler([Job(every_seconds=1, method=job)], START)
    fired_at_start = scheduler.advance_to(START)

    assert fired_at_start == []

    with pytest.raises(SimulationBoundsError, match='fired 10000 times in one advance'):
        scheduler.advance_to(START + timedelta(seconds=FIRES_PER_ADVANCE_MAX + 5))

    assert len(runs) == FIRES_PER_ADVANCE_MAX


def test_swarm_keeps_a_seeded_nonempty_subset_in_the_original_order() -> None:
    items = ('charge', 'charge', 'promo', 'checkout', 'question', 'visit')
    kept = {seed: swarmed(items, random.Random(seed)) for seed in range(40)}

    for seed, subset in kept.items():
        assert subset, seed
        assert subset == swarmed(items, random.Random(seed))
        assert list(subset) == [item for item in items if item in subset]

    assert len({frozenset(subset) for subset in kept.values()}) > 5
    assert swarm_names_of([swarmed, swarm_names_of]) == ['swarm_names_of', 'swarmed']

    with pytest.raises(SimulationBoundsError, match='at least one item'):
        swarmed((), random.Random(0))

    with pytest.raises(SimulationBoundsError, match='keep_chance'):
        swarmed(items, random.Random(0), keep_chance=0.0)


def test_simulate_runs_seeded_steps_and_checks_invariants_on_cadence() -> None:
    cadence = _Cadence()
    scenario = Scenario(actions=(cadence.tick, cadence.tock), invariants=(cadence.invariant,))
    timeline = _timeline(step_count=CADENCE_STEP_COUNT, checkpoint_every=4)
    run = simulate(scenario, timeline, seed=7)
    replay: list[str] = []

    assert run.sometimes_unreached() == ['tocked']
    assert any('action' in line for line in run.journal)

    chosen_first = list(cadence.chosen)
    cadence.chosen.clear()
    simulate(scenario, timeline, seed=7)
    replay.extend(cadence.chosen)

    assert chosen_first == replay
    assert cadence.checks == [3, 7, 11, 3, 7, 11]


def test_simulate_failure_names_the_seed_step_cause_and_journal() -> None:
    scenario = Scenario(actions=(_fail_at_five,), invariants=())
    failure = _failure_of(scenario, seed=3)

    assert failure.seed == 3
    assert failure.step == 5
    assert isinstance(failure.cause, SimulationInvariantError)
    assert 'step 5: working' in str(failure)
    assert 'the books do not balance' in str(failure)


def test_simulate_refuses_a_timeline_or_seed_out_of_bounds() -> None:
    scenario = Scenario(actions=(_idle,), invariants=())

    with pytest.raises(SimulationBoundsError, match='at least one action'):
        simulate(SCENARIO_EMPTY, _timeline(), seed=0)

    with pytest.raises(SimulationBoundsError, match='seed must be within'):
        simulate(scenario, _timeline(), seed=-1)

    with pytest.raises(SimulationBoundsError, match='checkpoint_every must be within'):
        simulate(scenario, _timeline(step_count=3, checkpoint_every=4), seed=0)


def test_faults_need_a_rate_and_produce_both_network_fates() -> None:
    with pytest.raises(SimulationBoundsError, match='at least one rate above zero'):
        Faults()

    with pytest.raises(SimulationBoundsError, match='network_rate must be within'):
        Faults(network_rate=1.5)

    faults = Faults(network_rate=0.5)
    rng = random.Random(11)
    fates = Counter(faults.network_fate(rng) for _ in range(FATE_SAMPLES))

    assert set(fates) == set(NetworkFate)
    assert 0.4 < fates[NetworkFate.DELIVERED] / FATE_SAMPLES < 0.6

    faults_stripe_rare = Faults(stripe_rate=0.0001)
    faults_stripe_always = Faults(stripe_rate=1.0)
    sendgrid_faulted = faults_stripe_rare.sendgrid_roll(rng)
    stripe_faulted = faults_stripe_always.stripe_roll(rng)

    assert not sendgrid_faulted
    assert stripe_faulted


@pytest.mark.django_db(transaction=True)
def test_database_faults_fail_a_statement_before_it_runs() -> None:
    faults = Faults(database_rate=1.0)
    installed = database_faults_installed(faults, random.Random(0))
    raised = pytest.raises(SimulationDatabaseFaultError, match='simulated database fault')

    with installed as tally, raised:
        create_test_account()

    assert tally.count == 1
    assert not Account.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_interleaver_drives_actors_through_seeded_orders_and_collects_errors() -> None:
    account = create_test_account()
    orders = {_interleaving_order(account, seed=seed) for seed in range(12)}

    assert len(orders) > 1


@pytest.mark.django_db
def test_interleaver_needs_autocommit() -> None:
    assert connection.in_atomic_block

    with transaction.atomic(), pytest.raises(SimulationError, match='needs autocommit'):
        Interleaver(random.Random(0), [Account.objects.count])


@pytest.mark.django_db
def test_rows_clean_reports_a_row_that_fails_its_own_validation() -> None:
    account = create_test_account()
    invariant = rows_clean(Account)

    invariant(Run(clock=Clock(START), rng=random.Random(0), seed=0))

    Account.objects.filter(pk=account.pk).update(email='not-an-email')

    with pytest.raises(SimulationInvariantError, match='fails full_clean'):
        invariant(Run(clock=Clock(START), rng=random.Random(0), seed=0))


def test_seeds_come_from_a_list_or_a_counted_range(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(pytest_plugin.ENVIRONMENT_SEEDS, raising=False)
    monkeypatch.delenv(pytest_plugin.ENVIRONMENT_SEED_START, raising=False)
    monkeypatch.delenv(pytest_plugin.ENVIRONMENT_SEED_COUNT, raising=False)

    assert pytest_plugin.seeds_from_environment() == [0]

    monkeypatch.setenv(pytest_plugin.ENVIRONMENT_SEED_START, '40')
    monkeypatch.setenv(pytest_plugin.ENVIRONMENT_SEED_COUNT, '3')

    assert pytest_plugin.seeds_from_environment() == [40, 41, 42]

    monkeypatch.setenv(pytest_plugin.ENVIRONMENT_SEEDS, '9, 2,7')

    assert pytest_plugin.seeds_from_environment() == [9, 2, 7]

    for text in ('-1', 'x', '1.5'):
        monkeypatch.setenv(pytest_plugin.ENVIRONMENT_SEEDS, text)

        with pytest.raises(SimulationBoundsError, match='SIMULATION_SEEDS'):
            pytest_plugin.seeds_from_environment()
