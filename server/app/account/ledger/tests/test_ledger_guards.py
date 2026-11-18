from __future__ import annotations

import re

import pytest
import stripe

from datetime import UTC, datetime
from decimal import Decimal
from functools import partialmethod
from typing_extensions import TYPE_CHECKING

from django.db import transaction

from app.account.constants import (
    ACCOUNT_LEDGER_ENTRY_REFERENCE_LENGTH_MAX,
    CHARGE_SECONDS_MAX,
    SECONDS_PER_HOUR,
    TOPUP_BALANCE_SECONDS,
)
from app.account.ledger.choices import AccountLedgerEntryKindChoices
from app.account.ledger.models import AccountLedgerEntry
from app.account.ledger.querysets import AccountLedgerEntryQuerySet
from app.account.ledger.services import factory_service
from app.account.ledger.services.factory_service import AccountLedgerEntryFactoryService
from app.account.models import Account
from app.account.payment.models import AccountPayment
from app.account.payment.tests.factories import create_test_payment
from app.account.tests.factories import create_test_account
from app.checkout import client
from app.core.exceptions import CheckoutUnknownError
from app.promo_code.models import PromoCode
from app.promo_code.tests.factories import create_test_promo_code
from harness.stripe import STRIPE_CURRENCY, STRIPE_SECRET_KEY

if TYPE_CHECKING:
    from collections.abc import Callable

    from django.db.models import Model

    from harness.stripe import StripeFake


pytestmark = pytest.mark.django_db
JOB_ID = '86dfb1d3b0140ecf2fd59075421f1cb5'
PAYMENT_INTENT_ID = 'pi_test_guard'
SESSION_ID = 'cs_test_guard'


def _aggregate_decimal(
    queryset: AccountLedgerEntryQuerySet,
    **expressions: object,
) -> dict[str, object]:
    _ = queryset

    assert list(expressions) == ['total']

    return {'total': Decimal(60)}


def _factory() -> AccountLedgerEntryFactoryService:
    factory = AccountLedgerEntry.services.factory

    assert factory.model_obj_is_new

    return factory


def _purchase_create_attempt(
    *,
    account_id: int,
    amount_cents: int = 1000,
    seconds: int = SECONDS_PER_HOUR,
    session_id: str = SESSION_ID,
) -> None:
    assert isinstance(account_id, int)
    assert isinstance(amount_cents, int)
    assert isinstance(seconds, int)
    assert session_id

    _factory()._purchase_create(
        account_id=account_id,
        amount_cents=amount_cents,
        currency=STRIPE_CURRENCY,
        payment_intent_id=PAYMENT_INTENT_ID,
        seconds=seconds,
        session_id=session_id,
    )


def _save_reported_as_update(
    service: AccountLedgerEntryFactoryService,
    *,
    save: Callable[[AccountLedgerEntryFactoryService], tuple[Model, bool]],
) -> tuple[Model, bool]:
    assert service.model_obj_is_new

    saved, created = save(service)

    assert created

    return saved, False


def _session_with_id(session_id: str) -> stripe.checkout.Session:
    assert session_id

    values = {'id': session_id, 'metadata': {'app': 'remi'}, 'object': 'checkout.session'}
    session = stripe.checkout.Session.construct_from(values, STRIPE_SECRET_KEY)

    assert session.metadata is not None
    assert session.metadata['app'] == client.CHECKOUT_METADATA_APP

    return session


def test_ledger_filters_refuse_an_undeclared_campaign_a_blank_value_or_a_naive_time() -> None:
    entries = AccountLedgerEntry.objects.all()
    moment_aware = datetime(2026, 11, 16, 9, 30, tzinfo=UTC)
    moment = moment_aware.replace(tzinfo=None)
    message_moment = re.escape(f'moment must carry a time zone: {moment!r}')

    with pytest.raises(ValueError, match=r"campaign must be one of .*: 'gala'"):
        entries.by_campaign('gala')

    with pytest.raises(ValueError, match='email must be non-empty'):
        entries.by_email('')

    with pytest.raises(ValueError, match='reference must be non-empty'):
        entries.by_reference('')

    with pytest.raises(ValueError, match=message_moment):
        entries.since(moment)

    assert not entries.by_campaign('wib').exists()
    assert not entries.by_email('avery@example.com').exists()
    assert not entries.by_reference('R').exists()
    assert not entries.since(moment_aware).exists()


def test_ledger_filters_match_email_without_regard_to_case_and_campaign_by_code() -> None:
    create_test_promo_code(campaign='wib', code='WIB2026', hours=1)
    create_test_promo_code(code='FRIEND', hours=1)

    avery = create_test_account(email='Avery@Example.com')
    morgan = create_test_account(email='morgan@example.com')

    avery.services.processor.promo_redeem('WIB2026')
    morgan.services.processor.promo_redeem('FRIEND')

    entries = AccountLedgerEntry.objects.promos()

    assert list(entries.by_email('avery@example.COM')) == list(avery.ledger_entries.all())
    assert list(entries.by_campaign('wib')) == list(avery.ledger_entries.all())
    assert list(entries.by_campaign('general')) == list(morgan.ledger_entries.all())


def test_ledger_sum_that_is_not_an_integer_is_a_programming_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    account = create_test_account(seconds=60)

    assert account.ledger_entries.balance_seconds() == 60

    monkeypatch.setattr(AccountLedgerEntryQuerySet, 'aggregate', _aggregate_decimal)

    with pytest.raises(TypeError, match='the ledger sum must be an int: Decimal'):
        account.ledger_entries.balance_seconds()


def test_checkout_metadata_integer_needs_a_named_key() -> None:
    metadata = {'seconds': '3600'}

    with pytest.raises(ValueError, match='key must be non-empty'):
        factory_service._metadata_integer(metadata, '')

    assert factory_service._metadata_integer(metadata, 'seconds') == SECONDS_PER_HOUR


def test_checkout_metadata_integer_takes_only_a_positive_whole_number_of_bounded_length() -> None:
    accepted = {'1': 1, '3600': 3600, '9' * 18: int('9' * 18)}
    refused = ['0', '-1', '01', '1.5', '', ' 1', '1e3', '9' * 19, 'one']

    for text, value in accepted.items():
        assert factory_service._metadata_integer({'seconds': text}, 'seconds') == value

    for text in refused:
        with pytest.raises(CheckoutUnknownError, match='carries no valid seconds'):
            factory_service._metadata_integer({'seconds': text}, 'seconds')

    with pytest.raises(CheckoutUnknownError, match='carries no seconds'):
        factory_service._metadata_integer({}, 'seconds')


def test_entry_create_refuses_an_undeclared_kind_or_a_reference_out_of_bounds() -> None:
    account = create_test_account()
    longest = 'r' * ACCOUNT_LEDGER_ENTRY_REFERENCE_LENGTH_MAX

    with pytest.raises(ValueError, match=r"kind must be one of .*: 'refund'"):
        _factory()._entry_create(account=account, kind='refund', reference='R', seconds=60)

    for reference in ('', longest + 'r'):
        with pytest.raises(ValueError, match='reference must be 1 to 255 characters'):
            _factory()._entry_create(
                account=account,
                kind=AccountLedgerEntryKindChoices.GRANT,
                reference=reference,
                seconds=60,
            )

    _factory()._entry_create(
        account=account,
        kind=AccountLedgerEntryKindChoices.GRANT,
        reference=longest,
        seconds=60,
    )

    assert account.ledger_entries.get().reference == longest
    assert account.ledger_entries.balance_seconds() == 60


def test_entry_create_refuses_an_unsaved_account_or_a_factory_already_holding_an_entry() -> None:
    account = create_test_account(seconds=60)
    unsaved = Account(email='unsaved@example.com', name='Unsaved')
    entry = account.ledger_entries.get()
    message_unsaved = re.escape(f'account must be saved: {unsaved!r}')
    message_held = re.escape(f'a ledger factory creates one entry, and already holds {entry!r}')

    with pytest.raises(ValueError, match=message_unsaved):
        _factory()._entry_create(
            account=unsaved,
            kind=AccountLedgerEntryKindChoices.GRANT,
            reference='R',
            seconds=60,
        )

    with pytest.raises(RuntimeError, match=message_held):
        entry.services.factory._entry_create(
            account=account,
            kind=AccountLedgerEntryKindChoices.GRANT,
            reference='R',
            seconds=60,
        )

    assert AccountLedgerEntry.objects.count() == 1

    _ = _factory()._entry_create(
        account=account,
        kind=AccountLedgerEntryKindChoices.GRANT,
        reference='R',
        seconds=60,
    )

    assert account.ledger_entries.grants().count() == 1


@pytest.mark.django_db(transaction=True)
def test_entry_create_outside_a_transaction_is_a_programming_error() -> None:
    account = create_test_account()

    with pytest.raises(RuntimeError, match='inside the transaction that locked its account'):
        _factory()._entry_create(
            account=account,
            kind=AccountLedgerEntryKindChoices.GRANT,
            reference='R',
            seconds=60,
        )

    assert not AccountLedgerEntry.objects.exists()

    with transaction.atomic():
        _ = _factory()._entry_create(
            account=account,
            kind=AccountLedgerEntryKindChoices.GRANT,
            reference='R',
            seconds=60,
        )

    assert account.ledger_entries.balance_seconds() == 60


def test_entry_saved_as_an_update_is_a_programming_error(monkeypatch: pytest.MonkeyPatch) -> None:
    account = create_test_account()
    save_original = AccountLedgerEntryFactoryService.save_model_obj
    save_reported = partialmethod(_save_reported_as_update, save=save_original)

    assert not account.ledger_entries.exists()

    monkeypatch.setattr(AccountLedgerEntryFactoryService, 'save_model_obj', save_reported)

    with pytest.raises(RuntimeError, match='was updated instead of created'):
        _factory().grant_create(account=account, reference='R', seconds=60)


def test_purchase_create_refuses_values_no_checkout_could_carry() -> None:
    account = create_test_account()

    with pytest.raises(ValueError, match='account_id must be positive: 0'):
        _purchase_create_attempt(account_id=0)

    with pytest.raises(ValueError, match='account_id must be positive: -3'):
        _purchase_create_attempt(account_id=-3)

    with pytest.raises(ValueError, match='amount_cents must not be negative: -1'):
        _purchase_create_attempt(account_id=account.pk, amount_cents=-1)

    with pytest.raises(ValueError, match='seconds must be positive: 0'):
        _purchase_create_attempt(account_id=account.pk, seconds=0)

    with pytest.raises(ValueError, match="session_id must name a checkout session: 'pi_123'"):
        _purchase_create_attempt(account_id=account.pk, session_id='pi_123')

    assert not AccountLedgerEntry.objects.exists()
    assert not AccountPayment.objects.exists()

    _purchase_create_attempt(account_id=account.pk)

    assert account.ledger_entries.purchases().by_reference(SESSION_ID).count() == 1


def test_purchase_create_for_an_account_that_is_gone_is_an_unknown_checkout() -> None:
    message = f'Checkout session {SESSION_ID} names account 999999, which is gone.'

    with pytest.raises(CheckoutUnknownError, match=message):
        _factory()._purchase_create(
            account_id=999_999,
            amount_cents=1000,
            currency=STRIPE_CURRENCY,
            payment_intent_id=PAYMENT_INTENT_ID,
            seconds=SECONDS_PER_HOUR,
            session_id=SESSION_ID,
        )

    assert not AccountLedgerEntry.objects.exists()
    assert not AccountPayment.objects.exists()


def test_entry_create_refuses_a_payment_or_promo_code_unsaved_or_of_another_account() -> None:
    account = create_test_account()
    other = create_test_account(email='morgan@example.com')
    payment_other = create_test_payment(other)
    unsaved_payment = AccountPayment(account=account, currency=STRIPE_CURRENCY, seconds=60)
    unsaved_promo = PromoCode(code='NEW', hours=5, redemptions_max=1)
    message_payment = re.escape(f'payment must be saved: {unsaved_payment!r}')
    message_other = f'payment {payment_other.pk} belongs to account {other.pk}, not {account.pk}'
    message_promo = re.escape(f'promo_code must be saved: {unsaved_promo!r}')

    with pytest.raises(ValueError, match=message_payment):
        _factory()._entry_create(
            account=account,
            kind=AccountLedgerEntryKindChoices.PURCHASE,
            payment=unsaved_payment,
            reference=SESSION_ID,
            seconds=60,
        )

    with pytest.raises(ValueError, match=message_other):
        _factory()._entry_create(
            account=account,
            kind=AccountLedgerEntryKindChoices.PURCHASE,
            payment=payment_other,
            reference=SESSION_ID,
            seconds=60,
        )

    with pytest.raises(ValueError, match=message_promo):
        _factory()._entry_create(
            account=account,
            kind=AccountLedgerEntryKindChoices.PROMO,
            promo_code=unsaved_promo,
            reference='NEW',
            seconds=60,
        )

    assert not AccountLedgerEntry.objects.exists()

    _ = _factory()._entry_create(
        account=other,
        kind=AccountLedgerEntryKindChoices.PURCHASE,
        payment=payment_other,
        reference=SESSION_ID,
        seconds=60,
    )

    assert payment_other.ledger_entries.balance_seconds() == 60


def test_purchase_record_refuses_a_non_purchase_entry_or_another_accounts_entry() -> None:
    account = create_test_account(seconds=60)
    promo_entry = account.ledger_entries.get()

    message_kind = re.escape(
        f'purchase hours are recorded only for a purchase entry: {promo_entry!r}',
    )

    assert promo_entry.kind == AccountLedgerEntryKindChoices.PROMO

    with pytest.raises(RuntimeError, match=message_kind):
        _factory()._purchase_record(account=account, entry=promo_entry)

    payment = create_test_payment(account, session_id=SESSION_ID)

    purchase = AccountLedgerEntry.objects.create(
        account=account,
        kind=AccountLedgerEntryKindChoices.PURCHASE,
        payment=payment,
        reference=SESSION_ID,
        seconds=SECONDS_PER_HOUR,
    )

    assert account.ledger_entries.purchases().get() == purchase

    other = create_test_account(email='morgan@example.com')
    message_owner = f'entry {purchase.pk} belongs to account {account.pk}, not {other.pk}'

    with pytest.raises(ValueError, match=message_owner):
        _factory()._purchase_record(account=other, entry=purchase)


def test_charge_grant_and_promo_entries_refuse_amounts_outside_their_bounds() -> None:
    account = create_test_account()
    unsaved_promo = PromoCode(code='NEW', hours=5, redemptions_max=1)
    message_unsaved = re.escape(f'promo must be saved: {unsaved_promo!r}')
    empty_promo = create_test_promo_code(code='EMPTY', hours=1)
    empty_promo.hours = 0

    with pytest.raises(ValueError, match='job_id must be 32 lowercase hexadecimal characters'):
        _factory().charge_create(account=account, job_id=JOB_ID.upper(), seconds=60)

    for seconds in (0, CHARGE_SECONDS_MAX + 1):
        with pytest.raises(ValueError, match=f'seconds must be 1 to {CHARGE_SECONDS_MAX}'):
            _factory().charge_create(account=account, job_id=JOB_ID, seconds=seconds)

    for seconds in (0, TOPUP_BALANCE_SECONDS + 1):
        with pytest.raises(ValueError, match=f'a grant moves 1 to {TOPUP_BALANCE_SECONDS}'):
            _factory().grant_create(account=account, reference='R', seconds=seconds)

    with pytest.raises(ValueError, match=message_unsaved):
        _factory().promo_create(account=account, promo=unsaved_promo)

    with pytest.raises(ValueError, match='promo EMPTY grants no hours: 0'):
        _factory().promo_create(account=account, promo=empty_promo)

    assert not AccountLedgerEntry.objects.exists()

    for seconds in (1, TOPUP_BALANCE_SECONDS):
        _factory().grant_create(account=account, reference=f'R{seconds}', seconds=seconds)

    assert account.ledger_entries.balance_seconds() == TOPUP_BALANCE_SECONDS + 1


def test_purchase_from_a_session_that_is_not_a_checkout_session_is_refused(
    stripe_fake: StripeFake,
) -> None:
    session = _session_with_id('pi_123')
    message = f'session must be a checkout session: {session.id!r}'

    with pytest.raises(ValueError, match=message):
        _factory().purchase_from_checkout(session)

    for session_id in ('pi_123', 'cs_', 'cs_test/../x'):
        with pytest.raises(CheckoutUnknownError, match='That is not a Stripe checkout session'):
            _factory().purchase_from_session(session_id)

    assert stripe_fake.sessions == {}
    assert not AccountLedgerEntry.objects.exists()
