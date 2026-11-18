from __future__ import annotations

import time_machine

from datetime import datetime, timedelta
from typing_extensions import TYPE_CHECKING

from django.utils import timezone

from harness.simulation.exceptions import SimulationBoundsError, SimulationError

if TYPE_CHECKING:
    from typing_extensions import Self


ADVANCE_SECONDS_MAX = 366 * 24 * 60 * 60


class Clock:
    def __init__(self, start: datetime) -> None:
        if not isinstance(start, datetime):
            message = f'clock start must be a datetime: {type(start).__name__}'
            raise TypeError(message)

        if start.tzinfo is None:
            message = f'clock start must carry a time zone: {start!r}'
            raise SimulationBoundsError(message)

        self._coordinates: time_machine.Traveller | None = None
        self._traveller = time_machine.travel(start, tick=False)

    def __enter__(self) -> Self:
        self._coordinates = self._traveller.start()
        return self

    def __exit__(self, *exception_information: object) -> None:
        _ = exception_information

        self._traveller.stop()
        self._coordinates = None

    def advance(self, seconds: int) -> None:
        if seconds < 1:
            message = f'clock advance must be at least one second: {seconds}'
            raise SimulationBoundsError(message)

        if seconds > ADVANCE_SECONDS_MAX:
            message = f'clock advance exceeds {ADVANCE_SECONDS_MAX} seconds: {seconds}'
            raise SimulationBoundsError(message)

        if self._coordinates is None:
            message = 'clock advanced outside its context'
            raise SimulationError(message)

        self._coordinates.shift(timedelta(seconds=seconds))

    def now(self) -> datetime:
        if self._coordinates is None:
            message = 'clock read outside its context'
            raise SimulationError(message)

        return timezone.now()
