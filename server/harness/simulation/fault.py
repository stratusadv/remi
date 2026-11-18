from __future__ import annotations

import math
import random

from contextlib import contextmanager
from dataclasses import dataclass
from enum import StrEnum
from typing_extensions import TYPE_CHECKING, Any

from django.db import connection

from harness.simulation.exceptions import SimulationBoundsError, SimulationDatabaseFaultError

if TYPE_CHECKING:
    from collections.abc import Callable, Generator


DATABASE_FAULT_MESSAGE = 'simulated database fault'
FAULT_RATE_MAX = 1.0


class NetworkFate(StrEnum):
    DELIVERED = 'delivered'
    REQUEST_DROPPED = 'request_dropped'
    RESPONSE_LOST = 'response_lost'


def _rate_validate(name: str, rate: float) -> None:
    if not name:
        message = f'name must be non-empty: {name!r}'
        raise ValueError(message)

    if math.isnan(rate):
        message = f'{name} must be within 0.0..{FAULT_RATE_MAX}: {rate}'
        raise SimulationBoundsError(message)

    if not 0.0 <= rate <= FAULT_RATE_MAX:
        message = f'{name} must be within 0.0..{FAULT_RATE_MAX}: {rate}'
        raise SimulationBoundsError(message)


@dataclass
class DatabaseFaultTally:
    count: int = 0


@dataclass(frozen=True)
class DatabaseFaultWrapper:
    faults: Faults
    rng: random.Random
    tally: DatabaseFaultTally

    def __call__(
        self,
        execute: Callable[..., object],
        sql: str,
        parameters: object,
        many: bool,
        context: dict[str, Any],
    ) -> object:
        if not isinstance(sql, str):
            message = f'sql must be a str: {type(sql).__name__}'
            raise TypeError(message)

        if many:
            if parameters is None:
                message = 'an executemany statement carries a parameter list'
                raise ValueError(message)

        if 'connection' not in context:
            message = f'context must carry the connection: {sorted(context)}'
            raise ValueError(message)

        try:
            self.faults.database_statement_roll(self.rng)
        except SimulationDatabaseFaultError:
            self.tally.count += 1

            raise

        return execute(sql, parameters, many, context)

    def __post_init__(self) -> None:
        if not isinstance(self.faults, Faults):
            message = f'faults must be a Faults: {type(self.faults).__name__}'
            raise TypeError(message)

        if not isinstance(self.rng, random.Random):
            message = f'rng must be a random.Random: {type(self.rng).__name__}'
            raise TypeError(message)

        if not isinstance(self.tally, DatabaseFaultTally):
            message = f'tally must be a DatabaseFaultTally: {type(self.tally).__name__}'
            raise TypeError(message)


@dataclass(frozen=True)
class Faults:
    database_rate: float = 0.0
    network_rate: float = 0.0
    sendgrid_rate: float = 0.0
    stripe_rate: float = 0.0

    def __post_init__(self) -> None:
        rates = {
            'database_rate': self.database_rate,
            'network_rate': self.network_rate,
            'sendgrid_rate': self.sendgrid_rate,
            'stripe_rate': self.stripe_rate,
        }

        for name, rate in rates.items():
            _rate_validate(name, rate)

        if not any(rates.values()):
            message = 'faults need at least one rate above zero'
            raise SimulationBoundsError(message)

    def database_statement_roll(self, rng: random.Random) -> None:
        if not isinstance(rng, random.Random):
            message = f'rng must be a random.Random: {type(rng).__name__}'
            raise TypeError(message)

        if self.database_rate == 0.0:
            return

        if rng.random() < self.database_rate:
            raise SimulationDatabaseFaultError(DATABASE_FAULT_MESSAGE)

    def network_fate(self, rng: random.Random) -> NetworkFate:
        if not isinstance(rng, random.Random):
            message = f'rng must be a random.Random: {type(rng).__name__}'
            raise TypeError(message)

        if self.network_rate == 0.0:
            return NetworkFate.DELIVERED

        if rng.random() >= self.network_rate:
            return NetworkFate.DELIVERED

        return rng.choice([NetworkFate.REQUEST_DROPPED, NetworkFate.RESPONSE_LOST])

    def sendgrid_roll(self, rng: random.Random) -> bool:
        if not isinstance(rng, random.Random):
            message = f'rng must be a random.Random: {type(rng).__name__}'
            raise TypeError(message)

        return _roll(rng, self.sendgrid_rate)

    def stripe_roll(self, rng: random.Random) -> bool:
        if not isinstance(rng, random.Random):
            message = f'rng must be a random.Random: {type(rng).__name__}'
            raise TypeError(message)

        return _roll(rng, self.stripe_rate)


def _roll(rng: random.Random, rate: float) -> bool:
    if not isinstance(rng, random.Random):
        message = f'rng must be a random.Random: {type(rng).__name__}'
        raise TypeError(message)

    if not 0.0 <= rate <= FAULT_RATE_MAX:
        message = f'rate must be within 0.0..{FAULT_RATE_MAX}: {rate}'
        raise SimulationBoundsError(message)

    if rate == 0.0:
        return False

    return rng.random() < rate


@contextmanager
def database_faults_installed(faults: Faults, rng: random.Random) -> Generator[DatabaseFaultTally]:
    if not isinstance(faults, Faults):
        message = f'faults must be a Faults: {type(faults).__name__}'
        raise TypeError(message)

    if not isinstance(rng, random.Random):
        message = f'rng must be a random.Random: {type(rng).__name__}'
        raise TypeError(message)

    tally = DatabaseFaultTally()
    wrapper = DatabaseFaultWrapper(faults=faults, rng=rng, tally=tally)

    with connection.execute_wrapper(wrapper):
        yield tally
