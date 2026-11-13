from __future__ import annotations

from concurrent.futures import Future
from decimal import Decimal
from typing_extensions import TYPE_CHECKING, NamedTuple, Self

if TYPE_CHECKING:
    from collections.abc import Callable


class MetricDispatch(NamedTuple):
    reference: str
    statistic_key: str
    sub_domain_key: str
    value: Decimal


class MetricExecutorFake:
    def __init__(self) -> None:
        self.dispatched = []

    def __call__(self) -> Self:
        return self

    def statistic_keys(self) -> list[str]:
        return [dispatch.statistic_key for dispatch in self.dispatched]

    def submit(self, function: Callable[..., None], *arguments: object) -> Future[None]:
        _ = function
        statistic_key, sub_domain_key, reference, value = arguments

        if not isinstance(value, Decimal):
            message = f'a metric value must be a Decimal, not {type(value).__name__}'
            raise TypeError(message)

        dispatch = MetricDispatch(
            reference=str(reference),
            statistic_key=str(statistic_key),
            sub_domain_key=str(sub_domain_key),
            value=value,
        )

        self.dispatched.append(dispatch)

        future = Future()
        future.set_result(None)

        return future
