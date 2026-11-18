from __future__ import annotations

import logging
import re

import stripe

from typing_extensions import TYPE_CHECKING

from django.db import transaction

from django_spire.contrib.constructor.service import BaseDjangoModelService

from app.account.constants import (
    ACCOUNT_LEDGER_ENTRY_REFERENCE_LENGTH_MAX,
    CHARGE_JOB_ID_PATTERN,
    CHARGE_SECONDS_MAX,
    SECONDS_PER_HOUR,
    TOPUP_BALANCE_SECONDS,
)
from app.account.ledger.choices import (
    ACCOUNT_LEDGER_ENTRY_KINDS_DEBIT,
    ACCOUNT_LEDGER_ENTRY_KINDS_PAYMENT,
    ACCOUNT_LEDGER_ENTRY_KINDS_ZERO,
    AccountLedgerEntryKindChoices,
)
from app.account.payment.models import AccountPayment
from app.checkout import client
from app.core.exceptions import CheckoutUnknownError, RequestInvalidError
from app.funnel.metric import (
    MetricAction,
    metric_action_record,
    metric_charge_record,
)
from system.environment import CURRENCY_PATTERN

if TYPE_CHECKING:
    from app.account.ledger.models import AccountLedgerEntry
    from app.account.models import Account
    from app.promo_code.models import PromoCode


logger = logging.getLogger(__name__)

CHECKOUT_METADATA_INTEGER_PATTERN = re.compile(r'[1-9][0-9]{0,17}')
REFUND_STATUSES_KNOWN = (*client.REFUND_STATUSES_STANDING, *client.REFUND_STATUSES_UNDONE)


def _entry_relations_validate(
    *,
    account: Account,
    kind: str,
    payment: AccountPayment | None,
    promo_code: PromoCode | None,
) -> None:
    if (promo_code is not None) != (kind == AccountLedgerEntryKindChoices.PROMO):
        message = f'a {kind} entry names a promo code exactly when it redeems one: {promo_code!r}'
        raise ValueError(message)

    if payment is not None:
        if payment.pk is None:
            message = f'payment must be saved: {payment!r}'
            raise ValueError(message)

    if payment is not None:
        if payment.account_id != account.pk:
            message = (
                f'payment {payment.pk} belongs to account {payment.account_id}, '
                f'not {account.pk}'
            )

            raise ValueError(message)

    if promo_code is not None:
        if promo_code.pk is None:
            message = f'promo_code must be saved: {promo_code!r}'
            raise ValueError(message)


def _metadata_integer(metadata: dict[str, str], key: str) -> int:
    if key == '':
        message = 'key must be non-empty'
        raise ValueError(message)

    if key not in metadata:
        message = f'The checkout session carries no {key}.'
        raise CheckoutUnknownError(message)

    text = str(metadata[key])

    if CHECKOUT_METADATA_INTEGER_PATTERN.fullmatch(text) is None:
        message = f'The checkout session carries no valid {key}.'
        raise CheckoutUnknownError(message)

    return int(text)


def _payment_from_intent(payment_intent: object, *, source: str) -> AccountPayment | None:
    if source == '':
        message = 'source must be non-empty'
        raise ValueError(message)

    if not isinstance(payment_intent, str | stripe.PaymentIntent | None):
        message = f'{source} carries a {type(payment_intent).__name__} as its payment intent'
        raise TypeError(message)

    if not isinstance(payment_intent, str):
        logger.info('%s names no payment intent, so it moves no hours', source)

        return None

    if client.PAYMENT_INTENT_PATTERN.fullmatch(payment_intent) is None:
        message = f'{source} names {payment_intent!r}, which is not a payment intent'
        raise RuntimeError(message)

    payment = AccountPayment.objects.by_payment_intent(payment_intent).first()

    if payment is not None:
        return payment

    session = client.checkout_session_by_payment_intent(payment_intent)

    if session is None:
        logger.info('%s is for payment intent %s, which no checkout took', source, payment_intent)

        return None

    if not client.checkout_session_owned(session):
        logger.info('%s is for checkout session %s of another app', source, session.id)

        return None

    from app.account.ledger.models import AccountLedgerEntry

    purchased = AccountLedgerEntry.services.factory.purchase_from_checkout(session)

    if not purchased:
        message = f'{source} returns money from checkout session {session.id}, which is not paid'
        raise RuntimeError(message)

    return AccountPayment.objects.by_payment_intent(payment_intent).get()


def _payment_return_validate(
    payment: AccountPayment,
    *,
    amount_cents: int,
    currency: str,
    source: str,
) -> None:
    if source == '':
        message = 'source must be non-empty'
        raise ValueError(message)

    if currency != payment.currency:
        message = f'{source} is in {currency}, and payment {payment.pk} was in {payment.currency}'
        raise RuntimeError(message)

    if amount_cents <= 0:
        message = f'{source} returns {amount_cents} cents of payment {payment.pk}'
        raise RuntimeError(message)

    amount_cents_paid = payment.amount_cents or 0

    if amount_cents_paid == 0:
        message = f'{source} returns money from payment {payment.pk}, which recorded no amount'
        raise RuntimeError(message)


def _payment_seconds_due(payment: AccountPayment, *, amount_cents: int) -> int:
    if amount_cents <= 0:
        message = f'amount_cents must be positive: {amount_cents}'
        raise ValueError(message)

    if not payment.amount_cents:
        message = f'payment {payment.pk} recorded no amount: {payment.amount_cents}'
        raise ValueError(message)

    amount_cents_paid = payment.amount_cents
    amount_cents_returned = min(amount_cents, amount_cents_paid)
    seconds_due = payment.seconds * amount_cents_returned // amount_cents_paid

    if not 0 <= seconds_due <= payment.seconds:
        message = f'payment {payment.pk} owes {seconds_due} of its {payment.seconds} seconds'
        raise RuntimeError(message)

    return seconds_due


class AccountLedgerEntryFactoryService(BaseDjangoModelService['AccountLedgerEntry']):
    obj: AccountLedgerEntry

    def _entry_create(
        self,
        *,
        account: Account,
        kind: str,
        reference: str,
        seconds: int,
        payment: AccountPayment | None = None,
        promo_code: PromoCode | None = None,
    ) -> AccountLedgerEntry:
        if kind not in AccountLedgerEntryKindChoices.values:
            message = f'kind must be one of {AccountLedgerEntryKindChoices.values}: {kind!r}'
            raise ValueError(message)

        if not 0 < len(reference) <= ACCOUNT_LEDGER_ENTRY_REFERENCE_LENGTH_MAX:
            message = (
                f'reference must be 1 to {ACCOUNT_LEDGER_ENTRY_REFERENCE_LENGTH_MAX} '
                f'characters: {reference!r}'
            )

            raise ValueError(message)

        seconds_sign = -1 if kind in ACCOUNT_LEDGER_ENTRY_KINDS_DEBIT else 1
        seconds_min = 0 if kind in ACCOUNT_LEDGER_ENTRY_KINDS_ZERO else 1

        if seconds * seconds_sign < seconds_min:
            message = f'a {kind} entry cannot move {seconds} seconds'
            raise ValueError(message)

        if account.pk is None:
            message = f'account must be saved: {account!r}'
            raise ValueError(message)

        if (payment is not None) != (kind in ACCOUNT_LEDGER_ENTRY_KINDS_PAYMENT):
            message = (
                f'a {kind} entry names a payment exactly when it moves paid hours: '
                f'{payment!r}'
            )

            raise ValueError(message)

        _entry_relations_validate(
            account=account,
            kind=kind,
            payment=payment,
            promo_code=promo_code,
        )

        if not self.model_obj_is_new:
            message = f'a ledger factory creates one entry, and already holds {self.obj!r}'
            raise RuntimeError(message)

        if not transaction.get_connection().in_atomic_block:
            message = 'a ledger entry is written inside the transaction that locked its account'
            raise RuntimeError(message)

        self.obj.account = account
        self.obj.kind = kind
        self.obj.payment = payment
        self.obj.promo_code = promo_code
        self.obj.reference = reference
        self.obj.seconds = seconds

        _, created = self.save_model_obj()

        if not created:
            message = f'the ledger entry {self.obj!r} was updated instead of created'
            raise RuntimeError(message)

        return self.obj

    def _purchase_create(
        self,
        *,
        account_id: int,
        amount_cents: int | None,
        currency: str,
        payment_intent_id: str | None,
        seconds: int,
        session_id: str,
    ) -> None:
        if account_id <= 0:
            message = f'account_id must be positive: {account_id}'
            raise ValueError(message)

        if amount_cents is not None:
            if amount_cents < 0:
                message = f'amount_cents must not be negative: {amount_cents}'
                raise ValueError(message)

        if CURRENCY_PATTERN.fullmatch(currency) is None:
            message = f'currency must be a lowercase three-letter code: {currency!r}'
            raise ValueError(message)

        if payment_intent_id is not None:
            if client.PAYMENT_INTENT_PATTERN.fullmatch(payment_intent_id) is None:
                message = f'payment_intent_id must name a payment intent: {payment_intent_id!r}'
                raise ValueError(message)

        if seconds <= 0:
            message = f'seconds must be positive: {seconds}'
            raise ValueError(message)

        if client.CHECKOUT_SESSION_PATTERN.fullmatch(session_id) is None:
            message = f'session_id must name a checkout session: {session_id!r}'
            raise ValueError(message)

        from app.account.models import Account

        with transaction.atomic():
            account = Account.objects.by_id(account_id).locked().first()

            if account is None:
                message = (
                    f'Checkout session {session_id} names account {account_id}, '
                    f'which is gone.'
                )

                raise CheckoutUnknownError(message)

            if account.ledger_entries.purchases().by_reference(session_id).exists():
                return

            payment = AccountPayment.services.factory.create(
                account=account,
                amount_cents=amount_cents,
                currency=currency,
                payment_intent_id=payment_intent_id,
                seconds=seconds,
                session_id=session_id,
            )

            entry = self._entry_create(
                account=account,
                kind=AccountLedgerEntryKindChoices.PURCHASE,
                payment=payment,
                reference=session_id,
                seconds=seconds,
            )

            self._purchase_record(account=account, entry=entry)

    def _purchase_record(self, *, account: Account, entry: AccountLedgerEntry) -> None:
        if entry.kind != AccountLedgerEntryKindChoices.PURCHASE:
            message = f'purchase hours are recorded only for a purchase entry: {entry!r}'
            raise RuntimeError(message)

        if entry.account_id != account.pk:
            message = f'entry {entry.pk} belongs to account {entry.account_id}, not {account.pk}'
            raise ValueError(message)

        metric_action_record(MetricAction.PURCHASE_HOURS)

    def _reinstatement_create(
        self,
        *,
        account: Account,
        payment: AccountPayment,
        reversal: AccountLedgerEntry,
    ) -> None:
        if reversal.kind != AccountLedgerEntryKindChoices.REVERSAL:
            message = f'only a reversal is reinstated, not {reversal!r}'
            raise RuntimeError(message)

        if reversal.payment_id != payment.pk:
            message = f'reversal {reversal.pk} belongs to payment {reversal.payment_id}'
            raise RuntimeError(message)

        reinstatements = account.ledger_entries.reinstatements()

        if reinstatements.by_reference(reversal.reference).exists():
            return

        _ = self._entry_create(
            account=account,
            kind=AccountLedgerEntryKindChoices.REINSTATEMENT,
            payment=payment,
            reference=reversal.reference,
            seconds=-reversal.seconds,
        )

    def _reversal_create(
        self,
        *,
        account: Account,
        payment: AccountPayment,
        reference: str,
        seconds_due: int,
    ) -> None:
        if client.REFUND_PATTERN.fullmatch(reference) is None:
            if client.DISPUTE_PATTERN.fullmatch(reference) is None:
                message = f'reference must name a Stripe refund or dispute: {reference!r}'
                raise ValueError(message)

        if not 0 <= seconds_due <= payment.seconds:
            message = f'seconds_due must be 0 to {payment.seconds}: {seconds_due}'
            raise ValueError(message)

        balance_seconds = account.ledger_entries.balance_seconds()

        if balance_seconds < 0:
            message = f'account {account.pk} holds {balance_seconds} seconds'
            raise RuntimeError(message)

        payment_seconds_held = payment.ledger_entries.balance_seconds()

        if not 0 <= payment_seconds_held <= payment.seconds:
            message = (
                f'payment {payment.pk} holds {payment_seconds_held} '
                f'of its {payment.seconds} seconds'
            )

            raise RuntimeError(message)

        seconds = min(seconds_due, balance_seconds, payment_seconds_held)

        _ = self._entry_create(
            account=account,
            kind=AccountLedgerEntryKindChoices.REVERSAL,
            payment=payment,
            reference=reference,
            seconds=-seconds,
        )

        balance_seconds_after = account.ledger_entries.balance_seconds()

        if balance_seconds_after != balance_seconds - seconds:
            message = (
                f'reversing {seconds} seconds of payment {payment.pk} moved account '
                f'{account.pk} from {balance_seconds} to {balance_seconds_after}'
            )

            raise RuntimeError(message)

    def charge_create(self, *, account: Account, job_id: str, seconds: int) -> None:
        if CHARGE_JOB_ID_PATTERN.fullmatch(job_id) is None:
            message = f'job_id must be 32 lowercase hexadecimal characters: {job_id!r}'
            raise ValueError(message)

        if not 0 < seconds <= CHARGE_SECONDS_MAX:
            message = f'seconds must be 1 to {CHARGE_SECONDS_MAX}: {seconds}'
            raise ValueError(message)

        _ = self._entry_create(
            account=account,
            kind=AccountLedgerEntryKindChoices.CHARGE,
            reference=job_id,
            seconds=-seconds,
        )

        metric_charge_record(seconds)

    def dispute_apply(self, dispute: stripe.Dispute) -> None:
        if client.DISPUTE_PATTERN.fullmatch(dispute.id) is None:
            message = f'dispute must be a Stripe dispute: {dispute.id!r}'
            raise ValueError(message)

        if dispute.status != client.DISPUTE_STATUS_LOST:
            logger.info('Dispute %s closed as %s, so its hours stay', dispute.id, dispute.status)

            return

        source = f'Dispute {dispute.id}'
        payment = _payment_from_intent(dispute.payment_intent, source=source)

        if payment is None:
            return

        _payment_return_validate(
            payment,
            amount_cents=dispute.amount,
            currency=dispute.currency,
            source=source,
        )

        from app.account.models import Account

        with transaction.atomic():
            account = Account.objects.by_id(payment.account_id).locked().get()

            if account.ledger_entries.reversals().by_reference(dispute.id).exists():
                return

            seconds_due = _payment_seconds_due(payment, amount_cents=dispute.amount)

            self._reversal_create(
                account=account,
                payment=payment,
                reference=dispute.id,
                seconds_due=seconds_due,
            )

    def event_apply(self, *, payload: bytes, signature: str) -> None:
        if payload == b'':
            raise RequestInvalidError(client.WEBHOOK_PAYLOAD_MISSING_MESSAGE)

        if signature == '':
            raise RequestInvalidError(client.WEBHOOK_SIGNATURE_MISSING_MESSAGE)

        event = client.webhook_event_construct(payload=payload, signature=signature)
        event_object = event.data.object

        if event.type in client.CHECKOUT_EVENT_TYPES:
            _ = self.purchase_from_session(event_object.id)

            return

        if event.type in client.REFUND_EVENT_TYPES:
            refund = client.refund_retrieve(event_object.id)

            self.refund_apply(refund)

            return

        if event.type == client.DISPUTE_CLOSED_EVENT_TYPE:
            if not isinstance(event_object, stripe.Dispute):
                message = f'a {event.type} event carries a {type(event_object).__name__}'
                raise TypeError(message)

            self.dispute_apply(event_object)

    def grant_create(self, *, account: Account, reference: str, seconds: int) -> None:
        if not 0 < seconds <= TOPUP_BALANCE_SECONDS:
            message = f'a grant moves 1 to {TOPUP_BALANCE_SECONDS} seconds: {seconds}'
            raise ValueError(message)

        if not 0 < len(reference) <= ACCOUNT_LEDGER_ENTRY_REFERENCE_LENGTH_MAX:
            message = (
                f'reference must be 1 to {ACCOUNT_LEDGER_ENTRY_REFERENCE_LENGTH_MAX} '
                f'characters: {reference!r}'
            )

            raise ValueError(message)

        _ = self._entry_create(
            account=account,
            kind=AccountLedgerEntryKindChoices.GRANT,
            reference=reference,
            seconds=seconds,
        )

    def promo_create(self, *, account: Account, promo: PromoCode) -> None:
        if promo.pk is None:
            message = f'promo must be saved: {promo!r}'
            raise ValueError(message)

        if promo.hours <= 0:
            message = f'promo {promo.code} grants no hours: {promo.hours}'
            raise ValueError(message)

        _ = self._entry_create(
            account=account,
            kind=AccountLedgerEntryKindChoices.PROMO,
            promo_code=promo,
            reference=promo.code,
            seconds=promo.hours * SECONDS_PER_HOUR,
        )

    def purchase_from_checkout(self, session: stripe.checkout.Session) -> bool:
        if client.CHECKOUT_SESSION_PATTERN.fullmatch(session.id) is None:
            message = f'session must be a checkout session: {session.id!r}'
            raise ValueError(message)

        if not client.checkout_session_owned(session):
            raise CheckoutUnknownError(client.CHECKOUT_SESSION_UNKNOWN_MESSAGE)

        if session.payment_status != 'paid':
            return False

        if session.currency is None:
            message = f'paid checkout session {session.id} carries no currency'
            raise RuntimeError(message)

        if not isinstance(session.payment_intent, str | None):
            message = f'checkout session {session.id} carries an expanded payment intent'
            raise TypeError(message)

        metadata = {} if session.metadata is None else session.metadata.to_dict()
        account_id = _metadata_integer(metadata, 'account_id')
        seconds = _metadata_integer(metadata, 'seconds')

        self._purchase_create(
            account_id=account_id,
            amount_cents=session.amount_total,
            currency=session.currency,
            payment_intent_id=session.payment_intent,
            seconds=seconds,
            session_id=session.id,
        )

        return True

    def purchase_from_session(self, session_id: str) -> bool:
        if client.CHECKOUT_SESSION_PATTERN.fullmatch(session_id) is None:
            raise CheckoutUnknownError(client.CHECKOUT_SESSION_INVALID_MESSAGE)

        session = client.checkout_session_retrieve(session_id)

        if not client.checkout_session_owned(session):
            logger.info('Checkout session %s belongs to another app', session_id)

            return False

        purchased = self.purchase_from_checkout(session)

        if not purchased:
            logger.info('Checkout session %s is not paid yet', session_id)

        return purchased

    def refund_apply(self, refund: stripe.Refund) -> None:
        if client.REFUND_PATTERN.fullmatch(refund.id) is None:
            message = f'refund must be a Stripe refund: {refund.id!r}'
            raise ValueError(message)

        if refund.status not in REFUND_STATUSES_KNOWN:
            message = f'refund {refund.id} has the unknown status {refund.status!r}'
            raise RuntimeError(message)

        source = f'Refund {refund.id}'
        payment = _payment_from_intent(refund.payment_intent, source=source)

        if payment is None:
            return

        _payment_return_validate(
            payment,
            amount_cents=refund.amount,
            currency=refund.currency,
            source=source,
        )

        from app.account.models import Account

        with transaction.atomic():
            account = Account.objects.by_id(payment.account_id).locked().get()
            reversal = account.ledger_entries.reversals().by_reference(refund.id).first()

            if refund.status in client.REFUND_STATUSES_UNDONE:
                if reversal is not None:
                    self._reinstatement_create(account=account, payment=payment, reversal=reversal)

                return

            if reversal is None:
                seconds_due = _payment_seconds_due(payment, amount_cents=refund.amount)

                self._reversal_create(
                    account=account,
                    payment=payment,
                    reference=refund.id,
                    seconds_due=seconds_due,
                )
