from __future__ import annotations

import logging
import random
import re
import time

import pytest
import stripe

from dataclasses import dataclass, field
from typing_extensions import TYPE_CHECKING

from app.account.constants import CHARGE_SECONDS_MAX, SECONDS_PER_HOUR
from app.account.ledger.models import AccountLedgerEntry
from app.account.payment.models import AccountPayment
from app.account.tests.factories import create_test_account
from harness.api import stripe_event_deliver
from harness.stripe import (
    STRIPE_CURRENCY,
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
    stripe_event_encode,
    stripe_signature_header,
)

if TYPE_CHECKING:
    from collections.abc import Mapping

    from django.test import Client

    from app.account.models import Account
    from harness.stripe import StripeFake


pytestmark = pytest.mark.django_db
CONSERVATION_SEEDS = 8
CONSERVATION_STEPS = 30
EVENT_CHECKOUT_COMPLETED = 'checkout.session.completed'
EVENT_DISPUTE_CLOSED = 'charge.dispute.closed'
EVENT_REFUND_CREATED = 'refund.created'
EVENT_REFUND_FAILED = 'refund.failed'
EVENT_REFUND_UPDATED = 'refund.updated'
JOB_ID = '86dfb1d3b0140ecf2fd59075421f1cb5'
LOGGER_LEDGER_FACTORY = 'app.account.ledger.services.factory_service'
REFUND_STATUSES_STANDING = ('pending', 'requires_action', 'succeeded')
REFUND_STATUSES_UNDONE = ('canceled', 'failed')


@dataclass
class Conservation:
    account: Account
    generator: random.Random
    stripe_fake: StripeFake
    disputed: set[int] = field(default_factory=set)
    dues: dict[str, int] = field(default_factory=dict)
    payments: list[AccountPayment] = field(default_factory=list)
    refunds: dict[str, tuple[AccountPayment, int]] = field(default_factory=dict)


def _conservation_charge(state: Conservation, name: str) -> None:
    _ = name

    assert state.account.payments.count() == len(state.payments)

    balance = state.account.ledger_entries.balance_seconds()

    if balance == 0:
        return

    seconds = state.generator.randint(1, min(balance, CHARGE_SECONDS_MAX))
    job_id = f'{state.generator.getrandbits(128):032x}'

    state.account.services.processor.charge(job_id=job_id, seconds=seconds)


def _conservation_check(state: Conservation, *, context: str) -> None:
    assert state.account.ledger_entries.balance_seconds() >= 0, context

    entries = state.account.ledger_entries

    for payment in state.account.payments.order_by('pk'):
        assert 0 <= payment.ledger_entries.balance_seconds() <= payment.seconds, context

    for reversal in entries.reversals().order_by('pk'):
        assert 0 <= -reversal.seconds <= state.dues[reversal.reference], context

    for reinstatement in entries.reinstatements().order_by('pk'):
        reversal = entries.reversals().by_reference(reinstatement.reference).get()

        assert reinstatement.seconds == -reversal.seconds, context


def _conservation_dispute(state: Conservation, name: str) -> None:
    assert name
    assert state.disputed <= {payment.pk for payment in state.payments}

    candidates = [payment for payment in state.payments if payment.pk not in state.disputed]

    if not candidates:
        return

    payment = state.generator.choice(candidates)
    amount_cents_paid = payment.amount_cents or 0
    amount = state.generator.randint(1, amount_cents_paid * 6 // 5)
    state.dues[f'du_{name}'] = payment.seconds * min(amount, amount_cents_paid) // amount_cents_paid
    state.disputed.add(payment.pk)

    values = {
        'amount': amount,
        'currency': STRIPE_CURRENCY,
        'id': f'du_{name}',
        'object': 'dispute',
        'payment_intent': payment.stripe_payment_intent_id,
        'status': 'lost',
    }

    dispute = stripe.Dispute.construct_from(values, STRIPE_SECRET_KEY)
    AccountLedgerEntry.services.factory.dispute_apply(dispute)


def _conservation_purchase(state: Conservation, name: str) -> None:
    assert name
    assert state.account.payments.count() == len(state.payments)

    payment = _purchase(
        state.stripe_fake,
        state.account,
        amount_cents=state.generator.randint(100, 5000),
        seconds=state.generator.randint(1, 5) * SECONDS_PER_HOUR,
        session_id=f'cs_{name}',
    )

    state.payments.append(payment)


def _conservation_refund(state: Conservation, name: str) -> None:
    assert name
    assert state.refunds.keys() <= state.dues.keys()

    if not state.payments:
        return

    payment = state.generator.choice(state.payments)
    amount_cents_paid = payment.amount_cents or 0
    refunded = sum(amount for held, amount in state.refunds.values() if held.pk == payment.pk)

    if refunded >= amount_cents_paid:
        return

    amount = state.generator.randint(1, amount_cents_paid - refunded)
    state.dues[f're_{name}'] = payment.seconds * amount // amount_cents_paid
    state.refunds[f're_{name}'] = (payment, amount)

    refund = state.stripe_fake.refund_add(
        amount=amount,
        payment_intent=payment.stripe_payment_intent_id,
        refund_id=f're_{name}',
        status=state.generator.choice(REFUND_STATUSES_STANDING),
    )

    AccountLedgerEntry.services.factory.refund_apply(refund)


def _conservation_undo(state: Conservation, name: str) -> None:
    _ = name

    assert state.refunds.keys() <= state.dues.keys()

    if not state.refunds:
        return

    refund_id = state.generator.choice(sorted(state.refunds))
    payment, amount = state.refunds.pop(refund_id)

    refund = state.stripe_fake.refund_add(
        amount=amount,
        payment_intent=payment.stripe_payment_intent_id,
        refund_id=refund_id,
        status=state.generator.choice(REFUND_STATUSES_UNDONE),
    )

    AccountLedgerEntry.services.factory.refund_apply(refund)


def _dispute_deliver(
    client: Client,
    *,
    amount: int,
    dispute_id: str,
    payment_intent: str | None,
    status: str,
) -> int:
    assert amount > 0
    assert dispute_id
    assert payment_intent is None or payment_intent.startswith('pi_')
    assert status

    dispute = {
        'amount': amount,
        'currency': STRIPE_CURRENCY,
        'id': dispute_id,
        'object': 'dispute',
        'payment_intent': payment_intent,
        'status': status,
    }

    return _event_deliver(client, event_object=dispute, event_type=EVENT_DISPUTE_CLOSED)


def _event_deliver(
    client: Client,
    *,
    event_object: Mapping[str, object],
    event_type: str,
) -> int:
    assert event_object.get('id')
    assert '.' in event_type

    payload = stripe_event_encode(event_object=event_object, event_type=event_type)
    timestamp = int(time.time())
    header = stripe_signature_header(payload, secret=STRIPE_WEBHOOK_SECRET, timestamp=timestamp)
    response = stripe_event_deliver(client, header=header, payload=payload)

    return response.status_code


def _purchase(
    stripe_fake: StripeFake,
    account: Account,
    *,
    amount_cents: int,
    seconds: int,
    session_id: str,
) -> AccountPayment:
    assert amount_cents >= 0
    assert seconds > 0
    assert session_id.startswith('cs_')

    payment_intent = _session_paid(
        stripe_fake,
        account,
        amount_cents=amount_cents,
        seconds=seconds,
        session_id=session_id,
    )

    purchased = AccountLedgerEntry.services.factory.purchase_from_session(session_id)

    assert purchased

    payment = AccountPayment.objects.by_checkout_session(session_id).get()

    assert payment.stripe_payment_intent_id == payment_intent

    return payment


def _refund_deliver(
    client: Client,
    stripe_fake: StripeFake,
    *,
    amount: int,
    event_type: str,
    payment_intent: str | None,
    refund_id: str,
    status: str,
) -> int:
    assert amount > 0
    assert '.' in event_type
    assert payment_intent is None or payment_intent.startswith('pi_')
    assert refund_id.startswith('re_')
    assert status in (*REFUND_STATUSES_STANDING, *REFUND_STATUSES_UNDONE)

    stripe_fake.refund_add(
        amount=amount,
        payment_intent=payment_intent,
        refund_id=refund_id,
        status=status,
    )

    refund = {'id': refund_id, 'object': 'refund'}
    return _event_deliver(client, event_object=refund, event_type=event_type)


def _session_paid(
    stripe_fake: StripeFake,
    account: Account,
    *,
    amount_cents: int,
    app: str = 'remi',
    seconds: int,
    session_id: str,
) -> str | None:
    assert amount_cents >= 0
    assert app
    assert seconds > 0
    assert session_id.startswith('cs_')

    metadata = {'account_id': str(account.pk), 'app': app, 'seconds': str(seconds)}

    session = stripe_fake.session_add(
        amount_total=amount_cents,
        metadata=metadata,
        payment_status='paid',
        session_id=session_id,
    )

    if not isinstance(session.payment_intent, str | None):
        message = f'checkout session {session_id} carries an expanded payment intent'
        raise TypeError(message)

    return session.payment_intent


def test_purchase_records_the_payment_stripe_took(stripe_fake: StripeFake) -> None:
    account = create_test_account()

    payment = _purchase(
        stripe_fake,
        account,
        amount_cents=2500,
        seconds=5 * SECONDS_PER_HOUR,
        session_id='cs_test_paid',
    )

    session = stripe_fake.sessions['cs_test_paid']
    entry = account.ledger_entries.purchases().get()

    stored = (
        payment.account_id,
        payment.amount_cents,
        payment.currency,
        payment.seconds,
        payment.stripe_checkout_session_id,
        payment.stripe_payment_intent_id,
    )

    taken = (
        account.pk,
        session.amount_total,
        session.currency,
        5 * SECONDS_PER_HOUR,
        session.id,
        session.payment_intent,
    )

    assert stored == taken
    assert entry.payment_id == payment.pk
    assert payment.ledger_entries.balance_seconds() == 5 * SECONDS_PER_HOUR


def test_free_purchases_record_payments_without_an_intent_for_a_refund_to_reach(
    stripe_fake: StripeFake,
) -> None:
    account = create_test_account()

    for session_id in ('cs_test_free1', 'cs_test_free2'):
        _ = _purchase(
            stripe_fake,
            account,
            amount_cents=0,
            seconds=SECONDS_PER_HOUR,
            session_id=session_id,
        )

    payments = account.payments.order_by('pk')
    stored = list(payments.values_list('amount_cents', 'stripe_payment_intent_id'))

    assert stored == [(0, None), (0, None)]
    assert account.ledger_entries.balance_seconds() == 2 * SECONDS_PER_HOUR


def test_refund_in_full_takes_back_the_hours_and_its_failure_restores_them(
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    account = create_test_account()

    payment = _purchase(
        stripe_fake,
        account,
        amount_cents=1000,
        seconds=SECONDS_PER_HOUR,
        session_id='cs_test_paid',
    )

    payment_intent = payment.stripe_payment_intent_id
    refund = {'id': 're_test_full', 'object': 'refund'}

    created = _refund_deliver(
        client,
        stripe_fake,
        amount=1000,
        event_type=EVENT_REFUND_CREATED,
        payment_intent=payment_intent,
        refund_id='re_test_full',
        status='succeeded',
    )

    balance_refunded = account.ledger_entries.balance_seconds()
    repeated = _event_deliver(client, event_object=refund, event_type=EVENT_REFUND_UPDATED)
    balance_repeated = account.ledger_entries.balance_seconds()

    failed = _refund_deliver(
        client,
        stripe_fake,
        amount=1000,
        event_type=EVENT_REFUND_FAILED,
        payment_intent=payment_intent,
        refund_id='re_test_full',
        status='failed',
    )

    failed_again = _event_deliver(client, event_object=refund, event_type=EVENT_REFUND_FAILED)
    reversals = list(account.ledger_entries.reversals().values_list('seconds', flat=True))
    reinstatements = list(account.ledger_entries.reinstatements().values_list('seconds', flat=True))

    assert [created, repeated, failed, failed_again] == [200, 200, 200, 200]
    assert balance_refunded == 0
    assert balance_repeated == 0
    assert reversals == [-SECONDS_PER_HOUR]
    assert reinstatements == [SECONDS_PER_HOUR]
    assert account.ledger_entries.balance_seconds() == SECONDS_PER_HOUR


def test_partial_refunds_take_back_hours_in_proportion_to_the_money_returned(
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    account = create_test_account()

    payment = _purchase(
        stripe_fake,
        account,
        amount_cents=3000,
        seconds=3 * SECONDS_PER_HOUR,
        session_id='cs_test_paid',
    )

    refunds = [('re_test_1', 1000), ('re_test_2', 500)]
    statuses = []

    for refund_id, amount in refunds:
        status = _refund_deliver(
            client,
            stripe_fake,
            amount=amount,
            event_type=EVENT_REFUND_CREATED,
            payment_intent=payment.stripe_payment_intent_id,
            refund_id=refund_id,
            status='pending',
        )

        statuses.append(status)

    reversals = dict(account.ledger_entries.reversals().values_list('reference', 'seconds'))

    assert statuses == [200, 200]
    assert reversals == {'re_test_1': -SECONDS_PER_HOUR, 're_test_2': -SECONDS_PER_HOUR // 2}
    assert account.ledger_entries.balance_seconds() == 3 * SECONDS_PER_HOUR // 2


def test_refund_takes_back_only_the_hours_left_and_never_touches_a_later_purchase(
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    account = create_test_account()

    first = _purchase(
        stripe_fake,
        account,
        amount_cents=1000,
        seconds=SECONDS_PER_HOUR,
        session_id='cs_test_first',
    )

    account.services.processor.charge(job_id=JOB_ID, seconds=SECONDS_PER_HOUR - 600)

    refunded = _refund_deliver(
        client,
        stripe_fake,
        amount=1000,
        event_type=EVENT_REFUND_CREATED,
        payment_intent=first.stripe_payment_intent_id,
        refund_id='re_test_first',
        status='succeeded',
    )

    balance_refunded = account.ledger_entries.balance_seconds()

    second = _purchase(
        stripe_fake,
        account,
        amount_cents=1000,
        seconds=SECONDS_PER_HOUR,
        session_id='cs_test_second',
    )

    refund = {'id': 're_test_first', 'object': 'refund'}
    repeated = _event_deliver(client, event_object=refund, event_type=EVENT_REFUND_UPDATED)
    reversals = list(account.ledger_entries.reversals().values_list('seconds', flat=True))

    assert [refunded, repeated] == [200, 200]
    assert balance_refunded == 0
    assert reversals == [-600]
    assert second.ledger_entries.balance_seconds() == SECONDS_PER_HOUR
    assert account.ledger_entries.balance_seconds() == SECONDS_PER_HOUR


def test_refund_of_hours_already_spent_is_recorded_once_and_moves_nothing(
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    account = create_test_account()

    payment = _purchase(
        stripe_fake,
        account,
        amount_cents=1000,
        seconds=SECONDS_PER_HOUR,
        session_id='cs_test_spent',
    )

    account.services.processor.charge(job_id=JOB_ID, seconds=SECONDS_PER_HOUR)

    statuses = []

    for event_type, status in [
        (EVENT_REFUND_CREATED, 'succeeded'),
        (EVENT_REFUND_UPDATED, 'succeeded'),
        (EVENT_REFUND_FAILED, 'failed'),
    ]:
        delivered = _refund_deliver(
            client,
            stripe_fake,
            amount=1000,
            event_type=event_type,
            payment_intent=payment.stripe_payment_intent_id,
            refund_id='re_test_spent',
            status=status,
        )

        statuses.append(delivered)

    reversals = list(account.ledger_entries.reversals().values_list('seconds', flat=True))
    reinstatements = list(account.ledger_entries.reinstatements().values_list('seconds', flat=True))

    assert statuses == [200, 200, 200]
    assert reversals == [0]
    assert reinstatements == [0]
    assert account.ledger_entries.balance_seconds() == 0


def test_refund_for_a_payment_remi_did_not_take_moves_no_hours(
    caplog: pytest.LogCaptureFixture,
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER_LEDGER_FACTORY)

    account = create_test_account(seconds=SECONDS_PER_HOUR)

    foreign_intent = _session_paid(
        stripe_fake,
        account,
        amount_cents=5000,
        app='business-base',
        seconds=10 * SECONDS_PER_HOUR,
        session_id='cs_test_foreign',
    )

    refunds = [
        ('re_test_elsewhere', 'pi_test_elsewhere'),
        ('re_test_foreign', foreign_intent),
        ('re_test_bare', None),
    ]

    statuses = []

    for refund_id, payment_intent in refunds:
        status = _refund_deliver(
            client,
            stripe_fake,
            amount=1000,
            event_type=EVENT_REFUND_CREATED,
            payment_intent=payment_intent,
            refund_id=refund_id,
            status='succeeded',
        )

        statuses.append(status)

    assert statuses == [200, 200, 200]
    assert not AccountPayment.objects.exists()
    assert not AccountLedgerEntry.objects.reversals().exists()
    assert account.ledger_entries.balance_seconds() == SECONDS_PER_HOUR
    assert 'pi_test_elsewhere, which no checkout took' in caplog.text
    assert 'checkout session cs_test_foreign of another app' in caplog.text
    assert 'Refund re_test_bare names no payment intent' in caplog.text


def test_refund_that_arrives_before_its_purchase_records_the_purchase_first(
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    account = create_test_account()

    payment_intent = _session_paid(
        stripe_fake,
        account,
        amount_cents=1000,
        seconds=SECONDS_PER_HOUR,
        session_id='cs_test_late',
    )

    refunded = _refund_deliver(
        client,
        stripe_fake,
        amount=1000,
        event_type=EVENT_REFUND_CREATED,
        payment_intent=payment_intent,
        refund_id='re_test_early',
        status='succeeded',
    )

    session = {'id': 'cs_test_late', 'object': 'checkout.session'}
    completed = _event_deliver(client, event_object=session, event_type=EVENT_CHECKOUT_COMPLETED)
    reversals = list(account.ledger_entries.reversals().values_list('seconds', flat=True))

    assert [refunded, completed] == [200, 200]
    assert account.ledger_entries.purchases().count() == 1
    assert reversals == [-SECONDS_PER_HOUR]
    assert account.ledger_entries.balance_seconds() == 0


def test_dispute_lost_takes_back_the_hours_and_one_won_or_warned_leaves_them(
    client: Client,
    stripe_fake: StripeFake,
) -> None:
    account = create_test_account()

    kept = _purchase(
        stripe_fake,
        account,
        amount_cents=1000,
        seconds=SECONDS_PER_HOUR,
        session_id='cs_test_kept',
    )

    lost = _purchase(
        stripe_fake,
        account,
        amount_cents=1000,
        seconds=SECONDS_PER_HOUR,
        session_id='cs_test_lost',
    )

    disputes = [
        (1000, 'du_test_won', kept.stripe_payment_intent_id, 'won'),
        (1000, 'du_test_warned', kept.stripe_payment_intent_id, 'warning_closed'),
        (1200, 'dp_test_lost', lost.stripe_payment_intent_id, 'lost'),
        (1200, 'dp_test_lost', lost.stripe_payment_intent_id, 'lost'),
    ]

    statuses = []

    for amount, dispute_id, payment_intent, status in disputes:
        delivered = _dispute_deliver(
            client,
            amount=amount,
            dispute_id=dispute_id,
            payment_intent=payment_intent,
            status=status,
        )

        statuses.append(delivered)

    reversals = dict(account.ledger_entries.reversals().values_list('reference', 'seconds'))

    assert statuses == [200, 200, 200, 200]
    assert reversals == {'dp_test_lost': -SECONDS_PER_HOUR}
    assert lost.ledger_entries.balance_seconds() == 0
    assert kept.ledger_entries.balance_seconds() == SECONDS_PER_HOUR
    assert account.ledger_entries.balance_seconds() == SECONDS_PER_HOUR


def test_refund_in_another_currency_or_with_an_unknown_status_is_a_programming_error(
    stripe_fake: StripeFake,
) -> None:
    account = create_test_account()

    payment = _purchase(
        stripe_fake,
        account,
        amount_cents=1000,
        seconds=SECONDS_PER_HOUR,
        session_id='cs_test_paid',
    )

    other_currency = stripe_fake.refund_add(
        amount=1000,
        currency='usd',
        payment_intent=payment.stripe_payment_intent_id,
        refund_id='re_test_usd',
        status='succeeded',
    )

    unknown_status = stripe_fake.refund_add(
        amount=1000,
        payment_intent=payment.stripe_payment_intent_id,
        refund_id='re_test_odd',
        status='mystery',
    )

    message_currency = f'Refund {other_currency.id} is in usd, and payment {payment.pk} was in cad'
    message_status = f"refund {unknown_status.id} has the unknown status 'mystery'"

    with pytest.raises(RuntimeError, match=message_currency):
        AccountLedgerEntry.services.factory.refund_apply(other_currency)

    with pytest.raises(RuntimeError, match=message_status):
        AccountLedgerEntry.services.factory.refund_apply(unknown_status)

    assert account.ledger_entries.balance_seconds() == SECONDS_PER_HOUR


def test_dispute_event_carrying_another_object_is_a_programming_error(
    stripe_fake: StripeFake,
) -> None:
    _ = stripe_fake
    refund = {'id': 're_test_1', 'object': 'refund'}
    payload = stripe_event_encode(event_object=refund, event_type=EVENT_DISPUTE_CLOSED)
    timestamp = int(time.time())
    header = stripe_signature_header(payload, secret=STRIPE_WEBHOOK_SECRET, timestamp=timestamp)

    assert stripe.WebhookSignature.verify_header(payload, header, STRIPE_WEBHOOK_SECRET)

    message = re.escape('a charge.dispute.closed event carries a Refund')

    with pytest.raises(TypeError, match=message):
        AccountLedgerEntry.services.factory.event_apply(
            payload=payload.encode(),
            signature=header,
        )


def test_refunds_and_disputes_never_take_more_hours_than_were_paid_for_or_are_held(
    stripe_fake: StripeFake,
) -> None:
    operations = [
        _conservation_charge,
        _conservation_dispute,
        _conservation_purchase,
        _conservation_purchase,
        _conservation_refund,
        _conservation_refund,
        _conservation_undo,
    ]

    for seed in range(CONSERVATION_SEEDS):
        generator = random.Random(seed)
        account = create_test_account(email=f'conservation{seed}@example.com')
        state = Conservation(account=account, generator=generator, stripe_fake=stripe_fake)

        for step in range(CONSERVATION_STEPS):
            operation = generator.choice(operations)
            context = f'seed {seed}, step {step}, {operation.__name__}'

            operation(state, f'test_c{seed}x{step}')
            _conservation_check(state, context=context)
