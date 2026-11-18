from __future__ import annotations

from collections.abc import Sequence
from typing_extensions import TYPE_CHECKING

from harness.simulation.exceptions import SimulationBoundsError

if TYPE_CHECKING:
    import random


KEEP_CHANCE_DEFAULT = 0.5
KEEP_CHANCE_MAX = 1.0


def swarmed[Item](
    items: Sequence[Item],
    rng: random.Random,
    *,
    keep_chance: float = KEEP_CHANCE_DEFAULT,
) -> tuple[Item, ...]:
    if not items:
        message = 'swarm needs at least one item'
        raise SimulationBoundsError(message)

    if not 0.0 < keep_chance <= KEEP_CHANCE_MAX:
        message = f'keep_chance must be within (0.0, {KEEP_CHANCE_MAX}]: {keep_chance}'
        raise SimulationBoundsError(message)

    distinct = list(dict.fromkeys(items))
    kept = [item for item in distinct if rng.random() < keep_chance]

    if not kept:
        kept = [rng.choice(distinct)]

    return tuple(item for item in items if item in kept)


def swarm_names_of(items: Sequence[object]) -> list[str]:
    if not isinstance(items, Sequence):
        message = f'items must be a Sequence: {type(items).__name__}'
        raise TypeError(message)

    return sorted({getattr(item, '__name__', str(item)) for item in items})
