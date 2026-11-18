from __future__ import annotations

from datetime import datetime
from typing_extensions import TYPE_CHECKING
from urllib.request import OpenerDirector
from zoneinfo import ZoneInfo

from django.core.cache import cache
from django.core.management import call_command

from django_spire.metric import metric as spire_metric

from app.account.question.pace import ask_limits
from app.account.tests.simulation_concurrent import RemiConcurrency
from app.account.tests.simulation_engine import (
    RemiSimulation,
    RemiWorld,
    SimulatedSendgrid,
    SimulatedStripe,
    email_day_cap_install,
)
from app.account.tests.simulation_model import WorldModel
from app.checkout import client as checkout_client
from harness.fixtures import OFFERS, PRICE_CURRENCY
from harness.metric import MetricExecutorFake
from harness.sendgrid import SENDGRID_API_KEY
from harness.simulation.fault import Faults
from harness.simulation.run import SEED_MAX, STEP_COUNT_MAX, Run, Scenario, Timeline, simulate
from harness.simulation.scheduler import Job
from harness.stripe import STRIPE_PUBLISHABLE_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
from system import base_settings

if TYPE_CHECKING:
    import pytest

    from django.test import Client

    from pytest_django.fixtures import Settings


CHECKPOINT_EVERY = 5
CONCURRENT_STEP_COUNT = 40
FAULTS_DATABASE = Faults(database_rate=0.03)
FAULTS_SERVICES = Faults(network_rate=0.15, sendgrid_rate=0.25, stripe_rate=0.2)
NIGHTLY_SECONDS = 86_400
START = datetime(2026, 11, 16, 8, 0, tzinfo=ZoneInfo('America/Edmonton'))
STEP_COUNT = 200
STEP_SECONDS = 60


def _fakes_install(
    monkeypatch: pytest.MonkeyPatch,
    world_model: WorldModel,
    client: Client,
) -> RemiWorld:
    assert not world_model.accounts
    assert world_model.offers

    stripe_fake = SimulatedStripe()
    sendgrid_fake = SimulatedSendgrid()
    metric = MetricExecutorFake()

    monkeypatch.setattr(checkout_client, 'stripe_client', stripe_fake.client)
    monkeypatch.setattr(OpenerDirector, 'open', sendgrid_fake.open)
    monkeypatch.setattr(spire_metric, '_record_executor', metric)
    email_day_cap_install(monkeypatch)

    return RemiWorld(
        client=client,
        metric=metric,
        model=world_model,
        sendgrid=sendgrid_fake,
        stripe=stripe_fake,
    )


def world_build(client: Client, monkeypatch: pytest.MonkeyPatch, settings: Settings) -> RemiWorld:
    settings.DJANGO_SPIRE_REMOTE_API_KEY = 'metric-key-simulation'
    settings.DJANGO_SPIRE_REMOTE_API_URL = 'https://portal.example.com/ds'
    settings.EMAIL_BACKEND = base_settings.EMAIL_BACKEND
    settings.REMI_ASK_BURST_COUNT = 3
    settings.REMI_ASK_BURST_SECONDS = 600
    settings.REMI_ASK_PACE_SECONDS = 300
    settings.REMI_ASK_TOKENS_ESTIMATE = 1000
    settings.REMI_ASK_TOKENS_SOFT_CAP = 20_000
    settings.REMI_ASK_WINDOW_DAYS = 30
    settings.REMI_OFFERS = dict(OFFERS)
    settings.REMI_PRICE_CURRENCY = PRICE_CURRENCY
    settings.SENDGRID_API_KEY = SENDGRID_API_KEY
    settings.STRIPE_PUBLISHABLE_KEY = STRIPE_PUBLISHABLE_KEY
    settings.STRIPE_SECRET_KEY = STRIPE_SECRET_KEY
    settings.STRIPE_WEBHOOK_SECRET = STRIPE_WEBHOOK_SECRET

    world_model = WorldModel(limits=ask_limits(), offers=dict(OFFERS))

    assert world_model.limits.burst_count == settings.REMI_ASK_BURST_COUNT
    assert world_model.limits.tokens_soft_cap == settings.REMI_ASK_TOKENS_SOFT_CAP

    return _fakes_install(monkeypatch, world_model, client)


def world_fresh(world: RemiWorld, monkeypatch: pytest.MonkeyPatch) -> RemiWorld:
    assert world.model.offers

    call_command('flush', '--noinput', verbosity=0)
    cache.clear()

    world_model = WorldModel(limits=world.model.limits, offers=dict(world.model.offers))
    fresh = _fakes_install(monkeypatch, world_model, world.client)
    fresh.faults = world.faults

    assert fresh.metric is not world.metric
    assert fresh.sendgrid is not world.sendgrid

    return fresh


def simulate_sequential(
    seed: int,
    simulation: RemiSimulation,
    *,
    step_count: int = STEP_COUNT,
) -> Run:
    assert 0 <= seed <= SEED_MAX
    assert simulation.actions()
    assert 0 < step_count <= STEP_COUNT_MAX

    nightly = Job(every_seconds=NIGHTLY_SECONDS, method=simulation.jobs_nightly)

    scenario = Scenario(
        actions=simulation.actions(),
        invariants=simulation.invariants(),
        jobs=(nightly,),
        setup=simulation.setup,
    )

    timeline = Timeline(
        checkpoint_every=CHECKPOINT_EVERY,
        start=START,
        step_count=step_count,
        step_seconds=STEP_SECONDS,
    )

    return simulate(scenario, timeline, seed=seed)


def simulate_concurrent(seed: int, world: RemiWorld) -> Run:
    assert 0 <= seed <= SEED_MAX
    assert world.faults is None

    concurrency = RemiConcurrency(world)
    simulation = RemiSimulation(world)

    invariants = (
        simulation.invariant_database_matches_model,
        simulation.invariant_balances_never_negative,
        simulation.invariant_ask_pacing_held,
    )

    scenario = Scenario(actions=(concurrency.step,), invariants=invariants, setup=concurrency.setup)

    timeline = Timeline(
        checkpoint_every=1,
        start=START,
        step_count=CONCURRENT_STEP_COUNT,
        step_seconds=STEP_SECONDS,
    )

    return simulate(scenario, timeline, seed=seed)
