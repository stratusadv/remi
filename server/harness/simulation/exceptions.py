from __future__ import annotations

from django.db import OperationalError


class SimulationError(Exception):
    pass


class SimulationActorError(SimulationError):
    pass


class SimulationBlockedError(SimulationError):
    pass


class SimulationBoundsError(SimulationError):
    pass


class SimulationDatabaseFaultError(OperationalError, SimulationError):
    pass


class SimulationInvariantError(SimulationError):
    pass


class SimulationNetworkFaultError(SimulationError):
    pass


class SimulationFailureError(SimulationError):
    def __init__(
        self,
        *,
        cause: BaseException,
        journal_tail: list[str],
        seed: int,
        step: int,
    ) -> None:
        if not isinstance(cause, BaseException):
            message = f'cause must be an exception: {type(cause).__name__}'
            raise TypeError(message)

        if not isinstance(journal_tail, list):
            message = f'journal_tail must be a list: {type(journal_tail).__name__}'
            raise TypeError(message)

        if seed < 0:
            message = f'seed must be non-negative: {seed}'
            raise ValueError(message)

        if step < 0:
            message = f'step must be non-negative: {step}'
            raise ValueError(message)

        self.cause = cause
        self.seed = seed
        self.step = step
        tail = '\n'.join(journal_tail)

        super().__init__(f'seed={seed} step={step}: {cause!r}\n{tail}')
