from __future__ import annotations

from typing_extensions import TYPE_CHECKING, NoReturn

from django.core.exceptions import ValidationError
from django.db.models import Model

from harness.simulation.exceptions import SimulationBoundsError, SimulationInvariantError

if TYPE_CHECKING:
    from collections.abc import Callable

    from harness.simulation.run import Run


    Invariant = Callable[[Run], None]


ROWS_PER_MODEL_MAX = 10_000


def _model_rows_clean(model: type[Model]) -> None:
    if not issubclass(model, Model):
        message = f'model must be a Model subclass: {model!r}'
        raise TypeError(message)

    manager = model._default_manager
    row_count = manager.count()

    if row_count > ROWS_PER_MODEL_MAX:
        message = f'{model.__name__} holds {row_count} rows, above {ROWS_PER_MODEL_MAX}'
        raise SimulationBoundsError(message)

    for row in manager.order_by('pk').iterator():
        try:
            row.full_clean()
        except ValidationError as error:
            message = f'{model.__name__} pk={row.pk} fails full_clean: {error.message_dict}'
            raise SimulationInvariantError(message) from error


def invariant_violated(message: str) -> NoReturn:
    if not message:
        message_empty = f'message must be non-empty: {message!r}'
        raise ValueError(message_empty)

    raise SimulationInvariantError(message)


def rows_clean(*models: type[Model]) -> Invariant:
    if not models:
        message = 'rows_clean needs at least one model'
        raise ValueError(message)

    if any(not issubclass(model, Model) for model in models):
        message = f'models must be Model subclasses: {models!r}'
        raise TypeError(message)

    def invariant(run: Run) -> None:
        _ = run

        for model in models:
            _model_rows_clean(model)

    invariant.__qualname__ = f'rows_clean({", ".join(model.__name__ for model in models)})'
    return invariant
