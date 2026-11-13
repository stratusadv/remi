from __future__ import annotations

from datetime import timedelta
from typing_extensions import TYPE_CHECKING

from django.db import transaction
from django.utils import timezone

from django_spire.contrib.constructor.service import BaseDjangoModelService

from app.account.constants import (
    CHARGE_JOB_ID_PATTERN,
    CHARGE_SECONDS_MAX,
    QUESTION_TOKENS_MAX,
    QUESTION_UNKNOWN_MESSAGE,
    SECONDS_PER_HOUR,
    SECONDS_PER_MINUTE,
    TENTHS_PER_HOUR,
)
from app.account.ledger.models import AccountLedgerEntry
from app.account.question.models import AccountQuestion
from app.account.question.pace import AskUsage, ask_limits, ask_pace
from app.account.tokens import token_generate, token_hash
from app.core.exceptions import (
    AskInactiveError,
    BalanceInsufficientError,
    PromoInvalidError,
    QuestionUnknownError,
    RequestInvalidError,
)
from app.promo_code.constants import (
    PROMO_CODE_INVALID_MESSAGE,
    PROMO_CODE_LENGTH_MAX,
    PROMO_CODE_LENGTH_MESSAGE,
)
from app.promo_code.models import PromoCode

if TYPE_CHECKING:
    from datetime import datetime

    from app.account.models import Account
    from app.account.question.pace import AskLimits, AskPace


def _ask_usage(
    *,
    account: Account,
    limits: AskLimits,
    now: datetime,
) -> tuple[datetime, AskUsage]:
    if now.tzinfo is None:
        message = f'now must carry a time zone: {now!r}'
        raise ValueError(message)

    if limits.burst_count <= 0:
        message = f'the burst must hold at least one question: {limits.burst_count}'
        raise ValueError(message)

    window_start = now - timedelta(days=limits.window_days)
    questions = account.questions.since(window_start)
    totals = questions.totals()

    if totals.asked_last is not None:
        now = max(now, totals.asked_last)

    burst_start = now - timedelta(seconds=limits.burst_seconds)
    asked_burst = tuple(questions.since(burst_start).asked_latest(limits.burst_count))

    usage = AskUsage(
        asked_burst=asked_burst,
        asked_last=totals.asked_last,
        question_count=totals.question_count,
        tokens=totals.tokens,
    )

    return now, usage


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

    def question_finish(self, *, question_id: int, tokens: int) -> AccountQuestion:
        if question_id <= 0:
            raise QuestionUnknownError(QUESTION_UNKNOWN_MESSAGE)

        if not 0 < tokens <= QUESTION_TOKENS_MAX:
            message = f'A question uses 1 to {QUESTION_TOKENS_MAX} tokens, not {tokens}.'
            raise RequestInvalidError(message)

        with transaction.atomic():
            account = self._account_locked()
            question = account.questions.by_id(question_id).locked().first()

            if question is None:
                raise QuestionUnknownError(QUESTION_UNKNOWN_MESSAGE)

            if question.finished_datetime is None:
                question.finished_datetime = timezone.now()
                question.tokens = tokens

                question.services.save_model_obj()

        return question

    def question_start(self) -> tuple[AccountQuestion | None, AskPace]:
        with transaction.atomic():
            limits = ask_limits()
            account = self._account_locked()
            now = timezone.now()
            window_start = now - timedelta(days=limits.window_days)

            if not account.ledger_entries.charges().since(window_start).exists():
                message = (
                    f'Ask answers questions for {limits.window_days} days after each recording '
                    f'remi processes. Process a recording to keep asking.'
                )

                raise AskInactiveError(message)

            now, usage = _ask_usage(account=account, limits=limits, now=now)
            pace = ask_pace(limits=limits, now=now, usage=usage)

            if pace.wait_seconds > 0:
                return None, pace

            question = AccountQuestion.services.factory.create(
                account=account,
                tokens=limits.tokens_estimate,
            )

        return question, pace

    def token_issue(self) -> str:
        token = token_generate()

        with transaction.atomic():
            account = self._account_locked()
            account.token_hash = token_hash(token)
            account.services.save_model_obj()

        return token
