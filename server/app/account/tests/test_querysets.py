from __future__ import annotations

import pytest

from app.account.constants import ACCOUNT_TOKEN_HASH_LENGTH, SECONDS_PER_HOUR
from app.account.models import Account
from app.account.tests.factories import create_test_account
from app.account.tokens import token_hash


pytestmark = pytest.mark.django_db
JOB_ID = '86dfb1d3b0140ecf2fd59075421f1cb5'


def test_token_hash_lookup_refuses_a_digest_of_the_wrong_length() -> None:
    account = create_test_account()
    accepted = Account.objects.by_token_hash('a' * ACCOUNT_TOKEN_HASH_LENGTH)

    assert len(account.token_hash) == ACCOUNT_TOKEN_HASH_LENGTH
    assert not accepted.exists()

    for length in (0, ACCOUNT_TOKEN_HASH_LENGTH - 1, ACCOUNT_TOKEN_HASH_LENGTH + 1):
        with pytest.raises(ValueError, match=f'not {length}'):
            Account.objects.by_token_hash('a' * length)


def test_token_hash_lookup_finds_only_the_account_holding_that_digest() -> None:
    avery = create_test_account()
    morgan = create_test_account(email='morgan@example.com')
    token = morgan.services.processor.token_issue()
    found = list(Account.objects.by_token_hash(token_hash(token)))

    assert found == [morgan]
    assert avery not in found


def test_balance_annotation_matches_the_ledger_of_each_account() -> None:
    empty = create_test_account(email='empty@example.com')
    seeded = create_test_account(email='seeded@example.com', seconds=SECONDS_PER_HOUR)
    charged = create_test_account(email='charged@example.com', seconds=SECONDS_PER_HOUR)

    charged.services.processor.charge(job_id=JOB_ID, seconds=600)

    annotated = dict(Account.objects.with_balance().values_list('email', 'balance_seconds'))

    for account in (empty, seeded, charged):
        assert annotated[account.email] == account.ledger_entries.balance_seconds()

    assert annotated == {
        'charged@example.com': SECONDS_PER_HOUR - 600,
        'empty@example.com': 0,
        'seeded@example.com': SECONDS_PER_HOUR,
    }
