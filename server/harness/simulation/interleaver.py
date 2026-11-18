from __future__ import annotations

import functools
import random
import threading

from typing_extensions import TYPE_CHECKING, Any

from django.db import connection

from harness.simulation.exceptions import (
    SimulationBlockedError,
    SimulationBoundsError,
    SimulationError,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence


ACTOR_COUNT_MAX = 16
ARRIVAL_WAIT_SECONDS = 1.0
BLOCKED_WAIT_SECONDS = 5.0
STATEMENT_COUNT_MAX = 100_000


class Interleaver:
    def __init__(
        self,
        rng: random.Random,
        actions: Sequence[Callable[[], object]],
        *,
        statement_hook: Callable[[], None] | None = None,
    ) -> None:
        if not isinstance(rng, random.Random):
            message = f'rng must be a random.Random: {type(rng).__name__}'
            raise TypeError(message)

        if not 1 <= len(actions) <= ACTOR_COUNT_MAX:
            message = f'actor count must be within 1..{ACTOR_COUNT_MAX}: {len(actions)}'
            raise SimulationBoundsError(message)

        if connection.in_atomic_block:
            message = 'interleaving needs autocommit: use transactional_db'
            raise SimulationError(message)

        self._actions = list(actions)
        self._any_arrived = threading.Event()
        self._arrived = [threading.Event() for _ in actions]
        self._errors: dict[int, Exception] = {}
        self._finished: set[int] = set()
        self._results: dict[int, object] = {}
        self._rng = rng
        self._statement_count = 0
        self._statement_hook = statement_hook
        self._turn = [threading.Event() for _ in actions]

    def drive(self) -> tuple[dict[int, object], dict[int, Exception]]:
        threads = [
            threading.Thread(
                args=(index,),
                daemon=True,
                name=f'simulation-actor-{index}',
                target=self._actor_run,
            )
            for index in range(len(self._actions))
        ]

        for thread in threads:
            thread.start()

        while len(self._finished) < len(self._actions):
            self._turn_give()

        for thread in threads:
            thread.join(BLOCKED_WAIT_SECONDS)

        return dict(self._results), dict(self._errors)

    def _actor_run(self, index: int) -> None:
        if not 0 <= index < len(self._actions):
            message = f'index must be within the actors: {index}'
            raise ValueError(message)

        try:
            wrapper = functools.partial(self._statement_wrapper, index=index)

            with connection.execute_wrapper(wrapper):
                self._boundary(index)
                self._results[index] = self._actions[index]()
        except Exception as error:
            self._errors[index] = error
        finally:
            connection.close()
            self._finished.add(index)
            self._arrived[index].set()
            self._any_arrived.set()

    def _boundary(self, index: int) -> None:
        if not 0 <= index < len(self._turn):
            message = f'index must be within the actors: {index}'
            raise ValueError(message)

        self._arrived[index].set()
        self._any_arrived.set()

        _ = self._turn[index].wait()

        self._turn[index].clear()

    def _ready_indexes(self) -> list[int]:
        return [
            index
            for index, arrived in enumerate(self._arrived)
            if arrived.is_set()
            if index not in self._finished
        ]

    def _statement_wrapper(
        self,
        execute: Callable[..., object],
        sql: str,
        parameters: object,
        many: bool,
        context: dict[str, Any],
        *,
        index: int,
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

        if not 0 <= index < len(self._actions):
            message = f'index must be within the actors: {index}'
            raise ValueError(message)

        self._boundary(index)

        if self._statement_hook is not None:
            self._statement_hook()

        return execute(sql, parameters, many, context)

    def _turn_give(self) -> None:
        self._any_arrived.clear()
        ready = self._ready_indexes()

        if not ready:
            if self._any_arrived.wait(BLOCKED_WAIT_SECONDS):
                return

            message = f'every actor stayed blocked inside the database for {BLOCKED_WAIT_SECONDS}s'
            raise SimulationBlockedError(message)

        self._statement_count += 1

        if self._statement_count > STATEMENT_COUNT_MAX:
            message = f'statement count exceeds {STATEMENT_COUNT_MAX}'
            raise SimulationBoundsError(message)

        index = self._rng.choice(ready)

        self._arrived[index].clear()
        self._turn[index].set()

        _ = self._arrived[index].wait(ARRIVAL_WAIT_SECONDS)
