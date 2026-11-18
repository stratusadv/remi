from __future__ import annotations

import pytest

from typing_extensions import Any, cast

from app.account.models import Account
from app.account.querysets import AccountQuerySet
from app.account.tests.factories import create_test_account
from app.core.querysets import manager_for


pytestmark = pytest.mark.django_db


def test_manager_for_refuses_a_class_that_is_not_a_queryset() -> None:
    with pytest.raises(TypeError, match="must be a QuerySet subclass: <class 'dict'>"):
        manager_for(cast('Any', dict))


def test_manager_for_returns_a_manager_that_carries_the_queryset_methods() -> None:
    manager = cast('Any', manager_for(AccountQuerySet))

    assert hasattr(manager, 'by_token_hash')
    assert hasattr(manager, 'with_balance')
    assert type(manager.get_queryset()) is AccountQuerySet
    assert type(Account.objects.all()) is AccountQuerySet


def test_by_id_refuses_a_key_that_is_not_positive() -> None:
    assert not Account.objects.by_id(1).exists()

    for primary_key in (0, -1):
        with pytest.raises(ValueError, match=f'primary_key must be positive: {primary_key}'):
            Account.objects.by_id(primary_key)


def test_by_id_and_locked_find_only_the_account_named() -> None:
    avery = create_test_account()
    _ = create_test_account(email='morgan@example.com')
    locked = Account.objects.by_id(avery.pk).locked()
    found = list(locked)

    assert Account.objects.count() == 2
    assert locked.query.select_for_update
    assert found == [avery]
