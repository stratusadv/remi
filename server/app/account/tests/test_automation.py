from __future__ import annotations

import pytest

from app.account.constants import SECONDS_PER_HOUR, TOPUP_BALANCE_SECONDS
from app.account.ledger.models import AccountLedgerEntry
from app.account.models import Account
from app.account.services import automation_service
from app.account.tests.factories import create_test_account


pytestmark = pytest.mark.django_db


def _complimentary_below_target(*, email: str, job_index: int) -> Account:
    account = create_test_account(email=email)
    job_id = f'{job_index:032x}'

    _ = account.services.processor.complimentary_start(reference=f'topup:test:{email}')

    account.services.processor.charge(job_id=job_id, seconds=SECONDS_PER_HOUR)

    return account


def test_complimentary_topup_fills_only_complimentary_accounts_below_the_target() -> None:
    below = _complimentary_below_target(email='below@example.com', job_index=1)
    full = create_test_account(email='full@example.com')
    plain = create_test_account(email='plain@example.com')

    _ = full.services.processor.complimentary_start(reference='topup:test:full')

    topped_count = Account.services.automation.complimentary_topup()

    assert topped_count == 1
    assert below.ledger_entries.balance_seconds() == TOPUP_BALANCE_SECONDS
    assert full.ledger_entries.balance_seconds() == TOPUP_BALANCE_SECONDS
    assert plain.ledger_entries.balance_seconds() == 0
    assert below.ledger_entries.grants().count() == 2
    assert full.ledger_entries.grants().count() == 1


def test_complimentary_topup_refuses_more_accounts_than_one_run_tops_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for index in range(3):
        _complimentary_below_target(email=f'person{index}@example.com', job_index=index + 1)

    monkeypatch.setattr(automation_service, 'COMPLIMENTARY_ACCOUNT_COUNT_MAX', 2)

    with pytest.raises(RuntimeError, match='3 accounts are complimentary, more than the 2'):
        Account.services.automation.complimentary_topup()

    assert AccountLedgerEntry.objects.grants().count() == 3
