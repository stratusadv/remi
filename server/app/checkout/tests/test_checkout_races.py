from __future__ import annotations

import threading

import pytest

from functools import partial, partialmethod
from typing_extensions import TYPE_CHECKING

from django.db import connection

from app.account.constants import SECONDS_PER_HOUR
from app.account.ledger.choices import AccountLedgerEntryKindChoices
from app.account.ledger.models import AccountLedgerEntry
from app.account.ledger.services.factory_service import AccountLedgerEntryFactoryService
from app.account.tests.factories import create_test_account

if TYPE_CHECKING:
    from collections.abc import Callable

    from app.account.models import Account
    from harness.stripe import StripeFake


LOCK_HOLD_SECONDS = 1.0
PURCHASE_SECONDS = 50 * SECONDS_PER_HOUR
THREAD_WAIT_SECONDS = 10.0


def _entry_create_pausing(
    service: AccountLedgerEntryFactoryService,
    *,
    done_second: threading.Event,
    entered_first: threading.Event,
    entry_create: Callable[..., AccountLedgerEntry],
    **fields: object,
) -> AccountLedgerEntry:
    assert service.model_obj_is_new
    assert entered_first.is_set() or not done_second.is_set()
    assert fields['kind'] == AccountLedgerEntryKindChoices.PURCHASE
    assert fields['seconds'] == PURCHASE_SECONDS
    assert fields['payment'] is not None

    if threading.current_thread().name == 'finish':
        entered_first.set()
        waited = done_second.wait(timeout=LOCK_HOLD_SECONDS)

        assert not waited

    return entry_create(service, **fields)


def _finish_thread(account: Account, session_id: str, *, outcomes: dict[str, bool]) -> None:
    assert session_id.startswith('cs_')
    assert 'finish' not in outcomes

    try:
        outcomes['finish'] = account.services.checkout.session_finish(session_id)
    finally:
        connection.close()


def _webhook_thread(
    session_id: str,
    *,
    done_second: threading.Event,
    outcomes: dict[str, bool],
) -> None:
    assert session_id.startswith('cs_')
    assert not done_second.is_set()
    assert 'webhook' not in outcomes

    try:
        factory = AccountLedgerEntry.services.factory
        outcomes['webhook'] = factory.purchase_from_session(session_id)
    finally:
        done_second.set()
        connection.close()


@pytest.mark.django_db(transaction=True)
def test_a_finish_and_a_webhook_racing_for_one_paid_session_credit_it_once(
    monkeypatch: pytest.MonkeyPatch,
    stripe_fake: StripeFake,
) -> None:
    account = create_test_account()
    session = account.services.checkout.session_create(
        hours=50,
        return_url='https://api.example.test/checkout/return/',
    )

    stripe_fake.pay(session.id)

    entered_first = threading.Event()
    done_second = threading.Event()
    outcomes = {}
    entry_create_original = AccountLedgerEntryFactoryService._entry_create

    entry_create_pausing = partialmethod(
        _entry_create_pausing,
        done_second=done_second,
        entered_first=entered_first,
        entry_create=entry_create_original,
    )

    finish = partial(_finish_thread, account, session.id, outcomes=outcomes)
    webhook = partial(_webhook_thread, session.id, done_second=done_second, outcomes=outcomes)

    monkeypatch.setattr(AccountLedgerEntryFactoryService, '_entry_create', entry_create_pausing)

    first = threading.Thread(target=finish, name='finish')
    second = threading.Thread(target=webhook, name='webhook')

    first.start()

    waited = entered_first.wait(timeout=THREAD_WAIT_SECONDS)

    assert waited

    second.start()
    first.join(timeout=THREAD_WAIT_SECONDS)
    second.join(timeout=THREAD_WAIT_SECONDS)
    monkeypatch.undo()

    assert outcomes == {'finish': True, 'webhook': True}
    assert account.ledger_entries.purchases().count() == 1
    assert account.payments.count() == 1
    assert account.ledger_entries.balance_seconds() == PURCHASE_SECONDS
