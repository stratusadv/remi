from __future__ import annotations

from typing_extensions import TYPE_CHECKING, Self, cast

from django.db.models import QuerySet

from django_spire.history.querysets import HistoryQuerySet

if TYPE_CHECKING:
    from django.db.models import Model


def manager_for[QuerySetT: QuerySet](queryset_class: type[QuerySetT]) -> QuerySetT:
    if not issubclass(queryset_class, QuerySet):
        message = f'queryset_class must be a QuerySet subclass: {queryset_class!r}'
        raise TypeError(message)

    return cast('QuerySetT', queryset_class.as_manager())


class BaseQuerySet[ModelT: Model](HistoryQuerySet, QuerySet[ModelT]):
    def by_id(self, primary_key: int) -> Self:
        if primary_key <= 0:
            message = f'primary_key must be positive: {primary_key}'
            raise ValueError(message)

        return self.filter(pk=primary_key)

    def locked(self) -> Self:
        return self.select_for_update()
