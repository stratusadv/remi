from __future__ import annotations

import logging
import re

from typing_extensions import TYPE_CHECKING

from django.db import transaction

from django_spire.contrib.constructor.service import BaseDjangoModelService

from app.account.constants import (
    ACCOUNT_LEDGER_ENTRY_REFERENCE_LENGTH_MAX,
    CHARGE_JOB_ID_PATTERN,
    CHARGE_SECONDS_MAX,
    SECONDS_PER_HOUR,
)
from app.account.ledger.choices import AccountLedgerEntryKindChoices
from app.checkout import client
from app.core.exceptions import CheckoutUnknownError, RequestInvalidError
from app.funnel.metric import (
    METRIC_REFERENCE_CHECKOUT,
    FunnelStatistic,
    SalesStatistic,
    UsageStatistic,
    metric_hours,
    metric_record,
    metric_revenue,
)

if TYPE_CHECKING:
    import stripe

    from app.account.ledger.models import AccountLedgerEntry
    from app.account.models import Account
    from app.promo_code.models import PromoCode


logger = logging.getLogger(__name__)

CHECKOUT_METADATA_INTEGER_PATTERN = re.compile(r'[1-9][0-9]{0,17}')


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


class AccountLedgerEntryFactoryService(BaseDjangoModelService['AccountLedgerEntry']):
    obj: AccountLedgerEntry

    def _entry_create(
        self,
        *,
        account: Account,
        kind: str,
        reference: str,
        seconds: int,
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

        seconds_sign = -1 if kind == AccountLedgerEntryKindChoices.CHARGE else 1

        if seconds * seconds_sign <= 0:
            message = f'a {kind} entry cannot move {seconds} seconds'
            raise ValueError(message)

        if account.pk is None:
            message = f'account must be saved: {account!r}'
            raise ValueError(message)

        if not self.model_obj_is_new:
            message = f'a ledger factory creates one entry, and already holds {self.obj!r}'
            raise RuntimeError(message)

        if not transaction.get_connection().in_atomic_block:
            message = 'a ledger entry is written inside the transaction that locked its account'
            raise RuntimeError(message)

        self.obj.account = account
        self.obj.kind = kind
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

            purchases = account.ledger_entries.purchases()

            if purchases.by_reference(session_id).exists():
                return

            entry = self._entry_create(
                account=account,
                kind=AccountLedgerEntryKindChoices.PURCHASE,
                reference=session_id,
                seconds=seconds,
            )

            metric_record(
                account.campaign,
                FunnelStatistic.PURCHASES,
                reference=METRIC_REFERENCE_CHECKOUT,
                source_model=entry,
            )

            if purchases.count() == 1:
                metric_record(
                    account.campaign,
                    FunnelStatistic.PAYING_CLIENTS,
                    reference=METRIC_REFERENCE_CHECKOUT,
                    source_model=entry,
                )

            self._revenue_record(account=account, amount_cents=amount_cents, entry=entry)

    def _revenue_record(
        self,
        *,
        account: Account,
        amount_cents: int | None,
        entry: AccountLedgerEntry,
    ) -> None:
        if entry.kind != AccountLedgerEntryKindChoices.PURCHASE:
            message = f'revenue is recorded only for a purchase entry: {entry!r}'
            raise RuntimeError(message)

        if amount_cents is not None:
            if amount_cents < 0:
                message = f'amount_cents must not be negative: {amount_cents}'
                raise ValueError(message)

        if amount_cents is None:
            logger.warning('Purchase %s carries no amount, so it records no revenue', entry.pk)
            return

        if amount_cents == 0:
            logger.warning('Purchase %s is free, so it records no revenue', entry.pk)
            return

        metric_record(
            account.campaign,
            SalesStatistic.REVENUE,
            reference=METRIC_REFERENCE_CHECKOUT,
            source_model=entry,
            value=metric_revenue(amount_cents),
        )

    def charge_create(self, *, account: Account, job_id: str, seconds: int) -> None:
        if CHARGE_JOB_ID_PATTERN.fullmatch(job_id) is None:
            message = f'job_id must be 32 lowercase hexadecimal characters: {job_id!r}'
            raise ValueError(message)

        if not 0 < seconds <= CHARGE_SECONDS_MAX:
            message = f'seconds must be 1 to {CHARGE_SECONDS_MAX}: {seconds}'
            raise ValueError(message)

        entry = self._entry_create(
            account=account,
            kind=AccountLedgerEntryKindChoices.CHARGE,
            reference=job_id,
            seconds=-seconds,
        )

        metric_record(
            account.campaign,
            UsageStatistic.MEETINGS,
            reference=job_id,
            source_model=entry,
        )

        metric_record(
            account.campaign,
            UsageStatistic.HOURS,
            reference=job_id,
            source_model=entry,
            value=metric_hours(seconds),
        )

        if account.ledger_entries.charges().count() == 1:
            metric_record(
                account.campaign,
                FunnelStatistic.ACTIVATIONS,
                reference=job_id,
                source_model=entry,
            )

    def promo_create(self, *, account: Account, promo: PromoCode) -> None:
        if promo.pk is None:
            message = f'promo must be saved: {promo!r}'
            raise ValueError(message)

        if promo.hours <= 0:
            message = f'promo {promo.code} grants no hours: {promo.hours}'
            raise ValueError(message)

        entry = self._entry_create(
            account=account,
            kind=AccountLedgerEntryKindChoices.PROMO,
            reference=promo.code,
            seconds=promo.hours * SECONDS_PER_HOUR,
        )

        metric_record(
            account.campaign,
            FunnelStatistic.PROMOS,
            reference=promo.code,
            source_model=entry,
        )

    def purchase_from_checkout(self, session: stripe.checkout.Session) -> bool:
        if client.CHECKOUT_SESSION_PATTERN.fullmatch(session.id) is None:
            message = f'session must be a checkout session: {session.id!r}'
            raise ValueError(message)

        if session.payment_status != 'paid':
            return False

        metadata = {} if session.metadata is None else session.metadata.to_dict()
        account_id = _metadata_integer(metadata, 'account_id')
        seconds = _metadata_integer(metadata, 'seconds')

        self._purchase_create(
            account_id=account_id,
            amount_cents=session.amount_total,
            seconds=seconds,
            session_id=session.id,
        )

        return True

    def purchase_from_event(self, *, payload: bytes, signature: str) -> None:
        if payload == b'':
            raise RequestInvalidError(client.WEBHOOK_PAYLOAD_MISSING_MESSAGE)

        if signature == '':
            raise RequestInvalidError(client.WEBHOOK_SIGNATURE_MISSING_MESSAGE)

        event = client.webhook_event_construct(payload=payload, signature=signature)

        if event.type not in client.CHECKOUT_EVENT_TYPES:
            return

        session_id = event.data.object.id

        if not self.purchase_from_session(session_id):
            logger.info('Checkout session %s is not paid yet', session_id)

    def purchase_from_session(self, session_id: str) -> bool:
        if client.CHECKOUT_SESSION_PATTERN.fullmatch(session_id) is None:
            raise CheckoutUnknownError(client.CHECKOUT_SESSION_INVALID_MESSAGE)

        session = client.checkout_session_retrieve(session_id)

        return self.purchase_from_checkout(session)
