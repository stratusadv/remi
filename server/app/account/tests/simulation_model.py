from __future__ import annotations

import hashlib
import re

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing_extensions import NamedTuple

from django.utils import timezone

from app.account.question.pace import AskLimits, AskPace, AskUsage, ask_pace
from app.funnel.choices import CampaignChoices


CAMPAIGN_GENERAL = 'general'
CENTS_PER_DOLLAR = 100
CHARGE_SECONDS_MAX = 21_600
CURRENCY_CODE_LENGTH = 3
HOURS_QUANTUM = Decimal('0.0001')
JOB_ID_PATTERN = re.compile(r'[0-9a-f]{32}')
PROMO_CODE_LENGTH_MAX = 64
QUESTION_TOKENS_MAX = 1_000_000
REFERENCE_TOPUP_PREFIX = 'topup:'
REVENUE_QUANTUM = Decimal('0.01')
SECONDS_PER_HOUR = 3600
STATISTIC_PREFIX = 'remi--'
TOKEN_LENGTH_MAX = 256
TOPUP_BALANCE_SECONDS = 1000 * SECONDS_PER_HOUR


class Expected(NamedTuple):
    code: str
    message: str
    status: int


class Metric(NamedTuple):
    campaign: str
    statistic: str


@dataclass
class QuestionModel:
    asked: datetime
    finished: bool
    question_id: int
    tokens: int
    tokens_window_before: int


@dataclass
class AccountModel:
    campaign: str
    email: str
    id: int
    name: str
    region: str
    token: str | None
    token_hash: str
    charges: dict[str, int] = field(default_factory=dict)
    charges_asked: list[datetime] = field(default_factory=list)
    complimentary: bool = False
    grants: dict[str, int] = field(default_factory=dict)
    promos: dict[str, int] = field(default_factory=dict)
    purchases: dict[str, int] = field(default_factory=dict)
    questions: list[QuestionModel] = field(default_factory=list)
    tokens_retired: list[str] = field(default_factory=list)

    @property
    def balance(self) -> int:
        credited = sum(self.grants.values()) + sum(self.promos.values())
        balance_seconds = credited + sum(self.purchases.values()) - sum(self.charges.values())

        assert balance_seconds >= 0

        return balance_seconds


@dataclass
class PromoModel:
    campaign: str
    code: str
    email: str
    hours: int
    redemptions_max: int
    downloaded: bool = False
    early_codes_issued: int = 0
    early_codes_max: int = 0
    early_hours: int = 0
    is_active: bool = True

    def issue_hours_take(self) -> int:
        assert self.email == ''
        assert self.early_codes_max == 0 or self.early_hours > 0

        if self.early_codes_issued < self.early_codes_max:
            self.early_codes_issued += 1

            return self.early_hours

        return self.hours


@dataclass
class SessionModel:
    account_pk: int
    amount_cents: int
    hours: int
    owned: bool
    session_id: str
    credited: bool = False
    paid: bool = False


@dataclass
class EmailModel:
    address: str
    campaign: str
    code: str
    sent_at: datetime


def metric_hours(seconds: int) -> Decimal:
    if seconds <= 0:
        message = f'seconds must be positive: {seconds}'
        raise ValueError(message)

    assert seconds <= CHARGE_SECONDS_MAX

    hours = (Decimal(seconds) / SECONDS_PER_HOUR).quantize(HOURS_QUANTUM, rounding=ROUND_HALF_UP)

    assert hours > 0

    return hours


def metric_revenue(cents: int) -> Decimal:
    if cents <= 0:
        message = f'cents must be positive: {cents}'
        raise ValueError(message)

    revenue = (Decimal(cents) / CENTS_PER_DOLLAR).quantize(REVENUE_QUANTUM)

    assert revenue * CENTS_PER_DOLLAR == cents

    return revenue


def _promo_text_refusal(stripped: str) -> Expected | None:
    assert stripped == stripped.strip()

    if stripped == '':
        return Expected('promo_invalid', 'Enter a promo code.', 400)

    if len(stripped) > PROMO_CODE_LENGTH_MAX:
        message = f'A promo code has at most {PROMO_CODE_LENGTH_MAX} characters.'
        return Expected('promo_invalid', message, 400)

    return None


def token_digest(token: str) -> str:
    assert 0 < len(token) <= TOKEN_LENGTH_MAX

    return hashlib.sha256(token.encode()).hexdigest()


@dataclass
class WorldModel:
    limits: AskLimits
    offers: dict[int, int]
    accounts: dict[int, AccountModel] = field(default_factory=dict)
    address_sent_at: dict[str, datetime] = field(default_factory=dict)
    email_day_counts: Counter[str] = field(default_factory=Counter)
    emails: list[EmailModel] = field(default_factory=list)
    metric_counts: Counter[Metric] = field(default_factory=Counter)
    metric_sums: dict[Metric, Decimal] = field(default_factory=dict)
    promos: dict[str, PromoModel] = field(default_factory=dict)
    sessions: dict[str, SessionModel] = field(default_factory=dict)

    def metric_add(self, *, campaign: str, statistic: str, value: Decimal = Decimal(1)) -> None:
        assert campaign in CampaignChoices.values
        assert value > 0

        if not statistic.startswith(STATISTIC_PREFIX):
            message = f'statistic must be a stored remi key: {statistic!r}'
            raise ValueError(message)

        key = Metric(campaign=campaign, statistic=statistic)
        self.metric_counts[key] += 1
        self.metric_sums[key] = self.metric_sums.get(key, Decimal(0)) + value

    def promo_find(self, code: str) -> PromoModel | None:
        assert code.strip() != ''

        key = code.strip().upper()
        promo = self.promos.get(key)

        assert promo is None or promo.code.upper() == key

        return promo

    def promo_redemption_count(self, promo: PromoModel) -> int:
        assert self.promos.get(promo.code.upper()) is promo

        return sum(promo.code in account.promos for account in self.accounts.values())

    def promo_refusal(self, *, account_email: str, code: str) -> Expected | None:
        assert account_email == account_email.strip()
        assert isinstance(code, str)

        stripped = code.strip()
        refusal = _promo_text_refusal(stripped)

        if refusal is not None:
            return refusal

        promo = self.promo_find(stripped)

        if promo is not None:
            if promo.is_active:
                return self._promo_limit_refusal(account_email, promo)

        return Expected('promo_invalid', 'That promo code is not valid.', 400)

    def _promo_limit_refusal(self, account_email: str, promo: PromoModel) -> Expected | None:
        assert account_email == account_email.strip()
        assert promo.is_active

        if self.promo_redemption_count(promo) >= promo.redemptions_max:
            return Expected('promo_invalid', 'That promo code has been fully redeemed.', 400)

        redeemers = [
            account.email.casefold()
            for account in self.accounts.values()
            if promo.code in account.promos
        ]

        if account_email.casefold() in redeemers:
            message = 'That promo code was already redeemed with this email address.'
            return Expected('promo_invalid', message, 400)

        if promo.campaign == CAMPAIGN_GENERAL:
            return None

        if not self.promo_campaign_redeemed(email=account_email, campaign=promo.campaign):
            return None

        label = CampaignChoices(promo.campaign).label
        message = f'This email address already redeemed the {label} offer.'

        return Expected('promo_invalid', message, 400)

    def promo_campaign_redeemed(self, *, email: str, campaign: str) -> bool:
        assert email == email.strip()
        assert campaign in CampaignChoices.values
        assert campaign != CAMPAIGN_GENERAL

        codes = {promo.code for promo in self.promos.values() if promo.campaign == campaign}

        return any(
            account.email.casefold() == email.casefold() and codes.intersection(account.promos)
            for account in self.accounts.values()
        )

    def promo_apply(self, account: AccountModel, code: str) -> None:
        assert self.accounts.get(account.id) is account
        assert code.strip() != ''

        promo = self.promo_find(code)

        if promo is None:
            message = f'the model holds no promo {code!r}'
            raise ValueError(message)

        if self.promo_redemption_count(promo) >= promo.redemptions_max:
            message = f'{promo.code} was redeemed past its limit of {promo.redemptions_max}'
            raise ValueError(message)

        if account.campaign == CAMPAIGN_GENERAL:
            account.campaign = promo.campaign

        account.promos[promo.code] = promo.hours * SECONDS_PER_HOUR

        self.metric_add(campaign=account.campaign, statistic='remi--funnel--promos')

    def charge_expected(self, account: AccountModel, job_id: str, seconds: int) -> Expected:
        assert self.accounts.get(account.id) is account
        assert JOB_ID_PATTERN.fullmatch(job_id) is not None
        assert 0 < seconds <= CHARGE_SECONDS_MAX

        if job_id in account.charges:
            return Expected('', '', 200)

        if account.balance < seconds:
            return Expected('balance_insufficient', '', 402)

        return Expected('', '', 200)

    def charge_apply(self, account: AccountModel, job_id: str, seconds: int) -> None:
        assert self.accounts.get(account.id) is account
        assert JOB_ID_PATTERN.fullmatch(job_id) is not None
        assert 0 < seconds <= CHARGE_SECONDS_MAX

        if job_id in account.charges:
            return

        if account.balance < seconds:
            message = f'account {account.id} cannot pay {seconds} seconds'
            raise ValueError(message)

        first = not account.charges
        account.charges[job_id] = seconds
        account.charges_asked.append(timezone.now())

        self.metric_add(campaign=account.campaign, statistic='remi--usage--meetings')

        self.metric_add(
            campaign=account.campaign,
            statistic='remi--usage--hours',
            value=metric_hours(seconds),
        )

        if first:
            self.metric_add(campaign=account.campaign, statistic='remi--funnel--activations')

    def purchase_apply(self, session: SessionModel) -> None:
        assert self.sessions.get(session.session_id) is session
        assert session.owned
        assert session.paid

        if session.credited:
            return

        account = self.accounts[session.account_pk]
        first = not account.purchases
        session.credited = True
        account.purchases[session.session_id] = session.hours * SECONDS_PER_HOUR

        self.metric_add(campaign=account.campaign, statistic='remi--funnel--purchases')

        if first:
            self.metric_add(campaign=account.campaign, statistic='remi--funnel--paying-clients')

        if session.amount_cents > 0:
            revenue = metric_revenue(session.amount_cents)

            self.metric_add(
                campaign=account.campaign,
                statistic='remi--sales--revenue',
                value=revenue,
            )

    def topup_apply(self, account: AccountModel, reference: str) -> int:
        assert self.accounts.get(account.id) is account
        assert reference.startswith(REFERENCE_TOPUP_PREFIX)

        if account.balance >= TOPUP_BALANCE_SECONDS:
            return 0

        seconds = TOPUP_BALANCE_SECONDS - account.balance
        account.grants[reference] = seconds

        assert 0 < seconds <= TOPUP_BALANCE_SECONDS
        assert account.balance == TOPUP_BALANCE_SECONDS

        return seconds

    def ask_active(self, account: AccountModel, now: datetime) -> bool:
        assert self.accounts.get(account.id) is account
        assert now.tzinfo is not None

        window_start = now - timedelta(days=self.limits.window_days)
        return any(asked > window_start for asked in account.charges_asked)

    def ask_usage(self, account: AccountModel, now: datetime) -> tuple[datetime, AskUsage]:
        assert self.accounts.get(account.id) is account
        assert now.tzinfo is not None

        window_start = now - timedelta(days=self.limits.window_days)
        recent = sorted(
            (question for question in account.questions if question.asked > window_start),
            key=lambda question: question.asked,
        )

        asked_last = recent[-1].asked if recent else None

        if asked_last is not None:
            now = max(now, asked_last)

        burst_start = now - timedelta(seconds=self.limits.burst_seconds)
        burst = [question.asked for question in recent if question.asked > burst_start]

        usage = AskUsage(
            asked_burst=tuple(burst[-self.limits.burst_count:]),
            asked_last=asked_last,
            question_count=len(recent),
            tokens=sum(question.tokens for question in recent),
        )

        return now, usage

    def ask_pace_expected(self, account: AccountModel, now: datetime) -> AskPace:
        assert self.accounts.get(account.id) is account
        assert now.tzinfo is not None

        now_effective, usage = self.ask_usage(account, now)
        return ask_pace(limits=self.limits, now=now_effective, usage=usage)

    def offers_listed(self, currency: str) -> list[dict[str, object]]:
        assert len(currency) == CURRENCY_CODE_LENGTH
        assert currency.islower()

        return [
            {'currency': currency, 'hours': hours, 'price_cents': price_cents}
            for hours, price_cents in sorted(self.offers.items())
        ]
