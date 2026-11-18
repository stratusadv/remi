from __future__ import annotations

import random

from collections import deque
from dataclasses import dataclass, field
from typing_extensions import TYPE_CHECKING

from harness.simulation.clock import Clock
from harness.simulation.exceptions import SimulationBoundsError, SimulationFailureError
from harness.simulation.scheduler import Scheduler

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence
    from datetime import datetime

    from harness.simulation.scheduler import Job


    Action = Callable[['Run'], None]
    Invariant = Callable[['Run'], None]


JOURNAL_LINES_MAX = 100_000
JOURNAL_TAIL_LINES = 40
SEED_MAX = 2**63 - 1
SOMETIMES_NAMES_MAX = 1000
STEP_COUNT_MAX = 1_000_000
STEP_SECONDS_MAX = 24 * 60 * 60


def _journal_build() -> deque[str]:
    return deque(maxlen=JOURNAL_LINES_MAX)


@dataclass
class Run:
    clock: Clock
    rng: random.Random
    seed: int
    journal: deque[str] = field(default_factory=_journal_build)
    sometimes_counts: dict[str, int] = field(default_factory=dict)
    step: int = 0

    def journal_tail(self) -> list[str]:
        return list(self.journal)[-JOURNAL_TAIL_LINES:]

    def log(self, message: str) -> None:
        if not isinstance(message, str):
            message_type = f'message must be a str: {type(message).__name__}'
            raise TypeError(message_type)

        self.journal.append(f'step {self.step}: {message}')

    def sometimes(self, name: str, *, condition: bool = True) -> None:
        if not name:
            message = f'name must be non-empty: {name!r}'
            raise ValueError(message)

        if name not in self.sometimes_counts:
            if len(self.sometimes_counts) >= SOMETIMES_NAMES_MAX:
                message = f'sometimes names exceed {SOMETIMES_NAMES_MAX}: {name!r}'
                raise SimulationBoundsError(message)

            self.sometimes_counts[name] = 0

        if condition:
            self.sometimes_counts[name] += 1

    def sometimes_unreached(self) -> list[str]:
        return sorted(name for name, count in self.sometimes_counts.items() if count == 0)


@dataclass(frozen=True, kw_only=True)
class Scenario:
    actions: Sequence[Action]
    invariants: Sequence[Invariant]
    jobs: Sequence[Job] = ()
    setup: Callable[[Run], None] | None = None


@dataclass(frozen=True, kw_only=True)
class Timeline:
    checkpoint_every: int
    start: datetime
    step_count: int
    step_seconds: int


def _bounds_validate(name: str, value: int, *, value_min: int, value_max: int) -> None:
    if not name:
        message = f'name must be non-empty: {name!r}'
        raise ValueError(message)

    if not value_min <= value <= value_max:
        message = f'{name} must be within {value_min}..{value_max}: {value}'
        raise SimulationBoundsError(message)


def _callable_name(target: Callable[..., object]) -> str:
    return getattr(target, '__qualname__', repr(target))


def _checkpoint_run(run: Run, invariants: Sequence[Invariant]) -> None:
    if not isinstance(run, Run):
        message = f'run must be a Run: {type(run).__name__}'
        raise TypeError(message)

    if not all(callable(invariant) for invariant in invariants):
        message = f'invariants must be callables: {invariants!r}'
        raise TypeError(message)

    for invariant in invariants:
        invariant(run)

    run.log(f'checkpoint held {len(invariants)} invariants')


def _step_run(run: Run, scenario: Scenario, scheduler: Scheduler) -> None:
    if not isinstance(run, Run):
        message = f'run must be a Run: {type(run).__name__}'
        raise TypeError(message)

    if not scenario.actions:
        message = 'a step needs at least one action'
        raise SimulationBoundsError(message)

    if not isinstance(scheduler, Scheduler):
        message = f'scheduler must be a Scheduler: {type(scheduler).__name__}'
        raise TypeError(message)

    for name in scheduler.advance_to(run.clock.now()):
        run.log(f'job {name}')

    action = run.rng.choice(scenario.actions)

    run.log(f'action {_callable_name(action)}')

    action(run)


def simulate(scenario: Scenario, timeline: Timeline, *, seed: int) -> Run:
    if not isinstance(scenario, Scenario):
        message = f'scenario must be a Scenario: {type(scenario).__name__}'
        raise TypeError(message)

    if not isinstance(timeline, Timeline):
        message = f'timeline must be a Timeline: {type(timeline).__name__}'
        raise TypeError(message)

    if not scenario.actions:
        message = 'simulate needs at least one action'
        raise SimulationBoundsError(message)

    if not 0 <= seed <= SEED_MAX:
        message = f'seed must be within 0..{SEED_MAX}: {seed}'
        raise SimulationBoundsError(message)

    _bounds_validate('step_count', timeline.step_count, value_min=1, value_max=STEP_COUNT_MAX)

    _bounds_validate(
        'step_seconds',
        timeline.step_seconds,
        value_min=1,
        value_max=STEP_SECONDS_MAX,
    )

    _bounds_validate(
        'checkpoint_every',
        timeline.checkpoint_every,
        value_min=1,
        value_max=timeline.step_count,
    )

    with Clock(timeline.start) as clock:
        rng = random.Random(seed)
        run = Run(clock=clock, rng=rng, seed=seed)
        scheduler = Scheduler(scenario.jobs, timeline.start)

        if scenario.setup is not None:
            scenario.setup(run)

        for step in range(timeline.step_count):
            run.step = step
            clock.advance(timeline.step_seconds)

            try:
                _step_run(run, scenario, scheduler)

                if (step + 1) % timeline.checkpoint_every == 0:
                    _checkpoint_run(run, scenario.invariants)
            except Exception as error:
                raise SimulationFailureError(
                    cause=error,
                    journal_tail=run.journal_tail(),
                    seed=seed,
                    step=step,
                ) from error

    return run
