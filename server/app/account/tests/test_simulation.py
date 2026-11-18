from __future__ import annotations

import random

import pytest

from collections import Counter
from typing_extensions import TYPE_CHECKING

from app.account.tests.simulation_engine import RemiSimulation
from app.account.tests.simulation_scenarios import (
    FAULTS_DATABASE,
    FAULTS_SERVICES,
    STEP_COUNT,
    simulate_concurrent,
    simulate_sequential,
    world_fresh,
)
from harness.simulation.run import SEED_MAX

if TYPE_CHECKING:
    from app.account.tests.simulation_engine import RemiWorld


CONCURRENT_SEEDS_TRIED = 6
NETWORK_FAULT_MARKERS = ('answer lost', 'before the server')
SOMETIMES_SEEDS_TRIED = 45

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.simulation]


def test_simulation_matches_the_model(simulation_seed: int, world: RemiWorld) -> None:
    assert 0 <= simulation_seed <= SEED_MAX

    run = simulate_sequential(simulation_seed, RemiSimulation(world))

    assert run.sometimes_counts['signup created an account'] > 0
    assert world.model.accounts


def test_simulation_matches_the_model_swarmed(simulation_seed: int, world: RemiWorld) -> None:
    assert 0 <= simulation_seed <= SEED_MAX

    simulation = RemiSimulation(world)

    simulation.swarm(random.Random(simulation_seed))

    assert simulation.actions()

    run = simulate_sequential(simulation_seed, simulation)

    assert run.step == STEP_COUNT - 1


def test_simulation_matches_the_model_under_network_and_service_faults(
    simulation_seed: int,
    world: RemiWorld,
) -> None:
    assert 0 <= simulation_seed <= SEED_MAX

    world.faults = FAULTS_SERVICES
    run = simulate_sequential(simulation_seed, RemiSimulation(world))

    network = [
        line
        for line in run.journal
        if any(marker in line for marker in NETWORK_FAULT_MARKERS)
    ]

    assert network


def test_simulation_keeps_each_request_whole_under_database_faults(
    simulation_seed: int,
    world: RemiWorld,
) -> None:
    assert 0 <= simulation_seed <= SEED_MAX

    world.faults = FAULTS_DATABASE
    run = simulate_sequential(simulation_seed, RemiSimulation(world))

    assert any('database fault' in line for line in run.journal)


def test_simulation_serializes_concurrent_actors(simulation_seed: int, world: RemiWorld) -> None:
    assert 0 <= simulation_seed <= SEED_MAX

    run = simulate_concurrent(simulation_seed, world)

    assert run.sometimes_counts['concurrent actors serialized'] > 0


def test_simulation_reaches_every_sometimes(
    monkeypatch: pytest.MonkeyPatch,
    world: RemiWorld,
) -> None:
    counts: Counter[str] = Counter()

    for seed in range(SOMETIMES_SEEDS_TRIED):
        fresh = world_fresh(world, monkeypatch)

        if seed % 3 == 1:
            fresh.faults = FAULTS_SERVICES

        if seed % 3 == 2:
            fresh.faults = FAULTS_DATABASE

        run = simulate_sequential(seed, RemiSimulation(fresh))

        counts.update(run.sometimes_counts)

    unreached = sorted(name for name, count in counts.items() if count == 0)

    assert counts
    assert unreached == [], unreached


def test_simulation_concurrent_reaches_every_race(
    monkeypatch: pytest.MonkeyPatch,
    world: RemiWorld,
) -> None:
    counts: Counter[str] = Counter()

    for seed in range(CONCURRENT_SEEDS_TRIED):
        run = simulate_concurrent(seed, world_fresh(world, monkeypatch))

        counts.update(run.sometimes_counts)

    unreached = sorted(name for name, count in counts.items() if count == 0)

    assert counts
    assert unreached == [], unreached
