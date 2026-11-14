from __future__ import annotations

import random

import pytest

from typing_extensions import TYPE_CHECKING

from django.db import IntegrityError, transaction

from app.account.constants import CHARGE_SECONDS_MAX, SECONDS_PER_HOUR
from app.account.ledger.choices import AccountLedgerEntryKindChoices
from app.account.ledger.models import AccountLedgerEntry
from app.account.tests.factories import create_test_account
from app.core.exceptions import BalanceInsufficientError
from app.promo_code.tests.factories import create_test_promo_code

if TYPE_CHECKING:
    from app.account.models import Account
    from harness.stripe import StripeFake


pytestmark = pytest.mark.django_db
MODEL_SEEDS = 12
MODEL_STEPS = 40


def _ledger_model_step(
    *,
    account: Account,
    charged: list[str],
    expected: int,
    generator: random.Random,
    operation: str,
    stripe_fake: StripeFake,
) -> int:
    if operation == 'charge_again':
        if charged:
            account.services.processor.charge(job_id=generator.choice(charged), seconds=1)

            return expected

    if operation == 'promo':
        hours = generator.randint(1, 5)
        code = f'P{account.pk}X{generator.getrandbits(48):x}'

        create_test_promo_code(code=code, hours=hours)
        account.services.processor.promo_redeem(code)

        return expected + hours * SECONDS_PER_HOUR

    if operation == 'purchase':
        seconds = generator.randint(1, 3) * SECONDS_PER_HOUR
        session_id = f'cs_test_model{account.pk}x{generator.getrandbits(48):x}'
        metadata = {'account_id': str(account.pk), 'app': 'remi', 'seconds': str(seconds)}

        stripe_fake.session_add(
            metadata=metadata,
            payment_status='paid',
            session_id=session_id,
        )

        assert AccountLedgerEntry.services.factory.purchase_from_session(session_id)
        assert AccountLedgerEntry.services.factory.purchase_from_session(session_id)

        return expected + seconds

    job_id = f'{generator.getrandbits(128):032x}'
    limit = generator.randint(1, CHARGE_SECONDS_MAX)
    candidates = [1, expected, expected + 1, CHARGE_SECONDS_MAX, limit]
    seconds = generator.choice([value for value in candidates if 0 < value <= CHARGE_SECONDS_MAX])

    if seconds > expected:
        with pytest.raises(BalanceInsufficientError):
            account.services.processor.charge(job_id=job_id, seconds=seconds)

        return expected

    account.services.processor.charge(job_id=job_id, seconds=seconds)
    charged.append(job_id)

    return expected - seconds


def test_ledger_database_refuses_a_wrongly_signed_or_repeated_entry() -> None:
    account = create_test_account()

    entries = [
        (AccountLedgerEntryKindChoices.CHARGE, 'JOB', 60),
        (AccountLedgerEntryKindChoices.CHARGE, 'JOB', 0),
        (AccountLedgerEntryKindChoices.PROMO, 'CODE', -60),
        (AccountLedgerEntryKindChoices.PURCHASE, 'cs_test_1', 0),
        (AccountLedgerEntryKindChoices.PROMO, 'SEED', 60),
    ]

    AccountLedgerEntry.objects.create(
        account=account,
        kind=AccountLedgerEntryKindChoices.PROMO,
        reference='SEED',
        seconds=60,
    )

    for kind, reference, seconds in entries:
        with pytest.raises(IntegrityError), transaction.atomic():
            AccountLedgerEntry.objects.create(
                account=account,
                kind=kind,
                reference=reference,
                seconds=seconds,
            )

    assert account.ledger_entries.balance_seconds() == 60


def test_ledger_entry_signed_against_its_kind_is_refused_before_the_database() -> None:
    account = create_test_account()

    entries = [
        (AccountLedgerEntryKindChoices.CHARGE, 60),
        (AccountLedgerEntryKindChoices.CHARGE, 0),
        (AccountLedgerEntryKindChoices.GRANT, -60),
        (AccountLedgerEntryKindChoices.GRANT, 0),
        (AccountLedgerEntryKindChoices.PROMO, -60),
        (AccountLedgerEntryKindChoices.PROMO, 0),
        (AccountLedgerEntryKindChoices.PURCHASE, -60),
        (AccountLedgerEntryKindChoices.PURCHASE, 0),
    ]

    for kind, seconds in entries:
        with pytest.raises(ValueError, match=f'a {kind} entry cannot move {seconds} seconds'):
            AccountLedgerEntry.services.factory._entry_create(
                account=account,
                kind=kind,
                reference='SIGN',
                seconds=seconds,
            )

        with pytest.raises(IntegrityError), transaction.atomic():
            AccountLedgerEntry.objects.create(
                account=account,
                kind=kind,
                reference='SIGN',
                seconds=seconds,
            )

    assert AccountLedgerEntry.objects.count() == 0


def test_ledger_matches_a_reference_model_under_random_operations(stripe_fake: StripeFake) -> None:
    operations = ['charge', 'charge', 'charge_again', 'promo', 'purchase']

    for seed in range(MODEL_SEEDS):
        generator = random.Random(seed)
        account = create_test_account(email=f'model{seed}@example.com')
        expected = 0
        charged = []

        for step in range(MODEL_STEPS):
            operation = generator.choice(operations)

            expected = _ledger_model_step(
                account=account,
                charged=charged,
                expected=expected,
                generator=generator,
                operation=operation,
                stripe_fake=stripe_fake,
            )

            context = f'seed {seed}, step {step}, {operation}'

            assert expected >= 0, context
            assert account.ledger_entries.balance_seconds() == expected, context
