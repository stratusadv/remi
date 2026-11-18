from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing_extensions import TYPE_CHECKING

from harness.simulation.exceptions import SimulationBoundsError

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence


EVERY_SECONDS_MAX = 366 * 24 * 60 * 60
FIRES_PER_ADVANCE_MAX = 10_000
JOB_COUNT_MAX = 256


@dataclass(frozen=True)
class Job:
    every_seconds: int
    method: Callable[[], None]

    @property
    def name(self) -> str:
        return getattr(self.method, '__qualname__', repr(self.method))


def _job_validate(job: Job) -> None:
    if not isinstance(job, Job):
        message = f'job must be a Job: {type(job).__name__}'
        raise TypeError(message)

    if job.every_seconds < 1:
        message = f'{job.name} every_seconds must be at least one: {job.every_seconds}'
        raise SimulationBoundsError(message)

    if job.every_seconds > EVERY_SECONDS_MAX:
        message = f'{job.name} every_seconds exceeds {EVERY_SECONDS_MAX}: {job.every_seconds}'
        raise SimulationBoundsError(message)


class Scheduler:
    def __init__(self, jobs: Sequence[Job], start: datetime) -> None:
        if not isinstance(start, datetime):
            message = f'start must be a datetime: {type(start).__name__}'
            raise TypeError(message)

        if len(jobs) > JOB_COUNT_MAX:
            message = f'job count exceeds {JOB_COUNT_MAX}: {len(jobs)}'
            raise SimulationBoundsError(message)

        for job in jobs:
            _job_validate(job)

        self._due = [start + timedelta(seconds=job.every_seconds) for job in jobs]
        self._jobs = list(jobs)

    def advance_to(self, moment: datetime) -> list[str]:
        if not isinstance(moment, datetime):
            message = f'moment must be a datetime: {type(moment).__name__}'
            raise TypeError(message)

        fired: list[str] = []

        for index in range(len(self._jobs)):
            fired.extend(self._job_fire_due(index, moment))

        return fired

    def _job_fire_due(self, index: int, moment: datetime) -> list[str]:
        if not 0 <= index < len(self._jobs):
            message = f'index must be within the jobs: {index}'
            raise ValueError(message)

        if not isinstance(moment, datetime):
            message = f'moment must be a datetime: {type(moment).__name__}'
            raise TypeError(message)

        job = self._jobs[index]
        fired: list[str] = []

        while self._due[index] <= moment:
            if len(fired) >= FIRES_PER_ADVANCE_MAX:
                message = f'{job.name} fired {FIRES_PER_ADVANCE_MAX} times in one advance'
                raise SimulationBoundsError(message)

            job.method()
            fired.append(job.name)
            self._due[index] += timedelta(seconds=job.every_seconds)

        return fired
