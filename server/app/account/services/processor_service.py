from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django.db import transaction

from django_spire.contrib.constructor.service import BaseDjangoModelService

from app.account.constants import (
    CHARGE_JOB_ID_PATTERN,
    CHARGE_SECONDS_MAX,
    SECONDS_PER_HOUR,
    SECONDS_PER_MINUTE,
    TENTHS_PER_HOUR,
)
from app.account.ledger.models import AccountLedgerEntry
from app.account.tokens import token_generate, token_hash
from app.core.exceptions import (
    BalanceInsufficientError,
    PromoInvalidError,
    RequestInvalidError,
)
from app.promo_code.constants import (
    PROMO_CODE_INVALID_MESSAGE,
    PROMO_CODE_LENGTH_MAX,
    PROMO_CODE_LENGTH_MESSAGE,
)
from app.promo_code.models import PromoCode

if TYPE_CHECKING:
    from app.account.models import Account


def _duration_text(seconds: int, *, rounded_up: bool) -> str:
    if seconds < 0:
        message = f'seconds must be non-negative: {seconds}'
        raise ValueError(message)

    if seconds < SECONDS_PER_HOUR:
        minutes = _quotient(dividend=seconds, divisor=SECONDS_PER_MINUTE, rounded_up=rounded_up)
        unit = 'minute' if minutes == 1 else 'minutes'

        return f'{minutes} {unit}'

    tenths = _quotient(
        dividend=seconds * TENTHS_PER_HOUR,
        divisor=SECONDS_PER_HOUR,
        rounded_up=rounded_up,
    )

    hours, tenth = divmod(tenths, TENTHS_PER_HOUR)
    amount = str(hours) if tenth == 0 else f'{hours}.{tenth}'
    unit = 'hour' if tenths == TENTHS_PER_HOUR else 'hours'

    return f'{amount} {unit}'


def _quotient(*, dividend: int, divisor: int, rounded_up: bool) -> int:
    if dividend < 0:
        message = f'dividend must be non-negative: {dividend}'
        raise ValueError(message)

    if divisor <= 0:
        message = f'divisor must be positive: {divisor}'
        raise ValueError(message)

    quotient = dividend // divisor

    if rounded_up:
        quotient = -(-dividend // divisor)

    if abs(quotient * divisor - dividend) >= divisor:
        message = f'{dividend} / {divisor} rounded to {quotient}, a whole step from the exact value'
        raise RuntimeError(message)

    return quotient


class AccountProcessorService(BaseDjangoModelService['Account']):
    obj: Account

    def _account_locked(self) -> Account:
        if self.obj.pk is None:
            message = f'the account must be saved: {self.obj!r}'
            raise ValueError(message)

        if not transaction.get_connection().in_atomic_block:
            message = 'an account is locked inside the transaction that writes it'
            raise RuntimeError(message)

        return self.obj_class.objects.by_id(self.obj.pk).locked().get()

    def charge(self, *, job_id: str, seconds: int) -> None:
        if CHARGE_JOB_ID_PATTERN.fullmatch(job_id) is None:
            message = 'A charge needs the 32-character job id of the recording.'
            raise RequestInvalidError(message)

        if not 0 < seconds <= CHARGE_SECONDS_MAX:
            message = f'A charge covers 1 to {CHARGE_SECONDS_MAX} seconds, not {seconds}.'
            raise RequestInvalidError(message)

        with transaction.atomic():
            account = self._account_locked()

            if account.ledger_entries.charges().by_reference(job_id).exists():
                return

            balance_seconds = account.ledger_entries.balance_seconds()

            if balance_seconds < 0:
                message = f'account {account.pk} holds {balance_seconds} seconds'
                raise RuntimeError(message)

            if balance_seconds < seconds:
                needed = _duration_text(seconds, rounded_up=True)
                held = _duration_text(balance_seconds, rounded_up=False)

                message = (
                    f'This recording needs {needed} of transcription and the account has {held} '
                    f'left. Buy more hours to transcribe it.'
                )

                raise BalanceInsufficientError(message)

            AccountLedgerEntry.services.factory.charge_create(
                account=account,
                job_id=job_id,
                seconds=seconds,
            )

            balance_seconds_after = account.ledger_entries.balance_seconds()

            if balance_seconds_after != balance_seconds - seconds:
                message = (
                    f'charging account {account.pk} {seconds} seconds moved its balance from '
                    f'{balance_seconds} to {balance_seconds_after}'
                )

                raise RuntimeError(message)

    def promo_redeem(self, code: str) -> Account:
        if code.strip() == '':
            message = 'Enter a promo code.'
            raise PromoInvalidError(message)

        if len(code.strip()) > PROMO_CODE_LENGTH_MAX:
            raise PromoInvalidError(PROMO_CODE_LENGTH_MESSAGE)

        with transaction.atomic():
            account = self._account_locked()
            promo = PromoCode.objects.active().by_code(code.strip()).locked().first()

            if promo is None:
                raise PromoInvalidError(PROMO_CODE_INVALID_MESSAGE)

            promo.services.processor.redeem(account)

        return account

    def token_issue(self) -> str:
        token = token_generate()

        with transaction.atomic():
            account = self._account_locked()
            account.token_hash = token_hash(token)
            account.services.save_model_obj()

        return token
