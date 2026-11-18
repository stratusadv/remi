from __future__ import annotations

import os
import re

import pytest

from harness.simulation.exceptions import SimulationBoundsError
from harness.simulation.run import SEED_MAX


ENVIRONMENT_SEED_COUNT = 'SIMULATION_SEED_COUNT'
ENVIRONMENT_SEED_START = 'SIMULATION_SEED_START'
ENVIRONMENT_SEEDS = 'SIMULATION_SEEDS'
INTEGER_PATTERN = re.compile(r'[0-9]{1,19}')
SEED_COUNT_DEFAULT = 1
SEED_COUNT_MAX = 100_000
SEED_FIXTURE_NAME = 'simulation_seed'


def _integer_bounded_parse(*, name: str, text: str, value_min: int, value_max: int) -> int:
    if name == '':
        message = 'name must be non-empty'
        raise ValueError(message)

    if INTEGER_PATTERN.fullmatch(text) is None:
        message = f'{name} must be a whole number, not {text!r}'
        raise SimulationBoundsError(message)

    value = int(text)

    if not value_min <= value <= value_max:
        message = f'{name} must be within {value_min}..{value_max}: {value}'
        raise SimulationBoundsError(message)

    return value


def _integer_environment_read(name: str, *, default: int, value_min: int, value_max: int) -> int:
    if name == '':
        message = 'name must be non-empty'
        raise ValueError(message)

    if not value_min <= default <= value_max:
        message = f'default must be within {value_min}..{value_max}: {default}'
        raise ValueError(message)

    text = os.environ.get(name, '').strip()

    if text == '':
        return default

    return _integer_bounded_parse(name=name, text=text, value_min=value_min, value_max=value_max)


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    if not isinstance(items, list):
        message = f'items must be a list: {type(items).__name__}'
        raise TypeError(message)

    for item in items:
        if SEED_FIXTURE_NAME in getattr(item, 'fixturenames', ()):
            item.add_marker(pytest.mark.simulation)


def pytest_generate_tests(metafunc: pytest.Metafunc) -> None:
    if not isinstance(metafunc, pytest.Metafunc):
        message = f'metafunc must be a pytest.Metafunc: {type(metafunc).__name__}'
        raise TypeError(message)

    if SEED_FIXTURE_NAME not in metafunc.fixturenames:
        return

    metafunc.parametrize(SEED_FIXTURE_NAME, seeds_from_environment())


def seeds_from_environment() -> list[int]:
    seeds_text = os.environ.get(ENVIRONMENT_SEEDS, '').strip()

    if seeds_text == '':
        start = _integer_environment_read(
            ENVIRONMENT_SEED_START,
            default=0,
            value_min=0,
            value_max=SEED_MAX,
        )

        count = _integer_environment_read(
            ENVIRONMENT_SEED_COUNT,
            default=SEED_COUNT_DEFAULT,
            value_min=1,
            value_max=SEED_COUNT_MAX,
        )

        seeds = list(range(start, start + count))
    else:
        seeds = [
            _integer_bounded_parse(
                name=ENVIRONMENT_SEEDS,
                text=part.strip(),
                value_min=0,
                value_max=SEED_MAX,
            )
            for part in seeds_text.split(',')
        ]

    if len(seeds) > SEED_COUNT_MAX:
        message = f'seed count exceeds {SEED_COUNT_MAX}: {len(seeds)}'
        raise SimulationBoundsError(message)

    return seeds
