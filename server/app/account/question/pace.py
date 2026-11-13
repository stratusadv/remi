from __future__ import annotations

import math

from datetime import datetime, timedelta
from typing_extensions import NamedTuple

from django.conf import settings


SECONDS_PER_MINUTE = 60


class AskLimits(NamedTuple):
    burst_count: int
    burst_seconds: int
    pace_seconds: int
    tokens_estimate: int
    tokens_soft_cap: int
    window_days: int


class AskPace(NamedTuple):
    notice: str
    wait_seconds: int


class AskUsage(NamedTuple):
    asked_burst: tuple[datetime, ...]
    asked_last: datetime | None
    question_count: int
    tokens: int


def _limits_validate(limits: AskLimits) -> None:
    if not isinstance(limits, AskLimits):
        message = f'limits must be AskLimits: {type(limits).__name__}'
        raise TypeError(message)

    counts = {
        'burst_count': limits.burst_count,
        'burst_seconds': limits.burst_seconds,
        'pace_seconds': limits.pace_seconds,
        'tokens_estimate': limits.tokens_estimate,
        'tokens_soft_cap': limits.tokens_soft_cap,
        'window_days': limits.window_days,
    }

    for name, value in counts.items():
        if value <= 0:
            message = f'the Ask limit {name} must be positive: {value}'
            raise ValueError(message)

    if timedelta(seconds=limits.burst_seconds) > timedelta(days=limits.window_days):
        message = f'the burst of {limits.burst_seconds} seconds outlasts the window'
        raise ValueError(message)


def _minutes_text(seconds: int) -> str:
    if seconds <= 0:
        message = f'seconds must be positive: {seconds}'
        raise ValueError(message)

    minutes = -(-seconds // SECONDS_PER_MINUTE)
    unit = 'minute' if minutes == 1 else 'minutes'

    return f'{minutes} {unit}'


def _notice(limits: AskLimits, usage: AskUsage) -> str:
    if limits.tokens_soft_cap <= 0:
        message = f'the soft cap must be positive: {limits.tokens_soft_cap}'
        raise ValueError(message)

    if usage.tokens < 0:
        message = f'tokens must not be negative: {usage.tokens}'
        raise ValueError(message)

    pace = _minutes_text(limits.pace_seconds)

    if usage.tokens >= limits.tokens_soft_cap:
        return f'You have asked a lot this month, so remi answers one question every {pace}.'

    if usage.tokens * 2 < limits.tokens_soft_cap:
        return ''

    left = _questions_left(limits, usage)
    left_text = 'About 1 is left' if left == 1 else f'About {left} are left'

    return (
        f"You have used half of this month's full-speed questions. {left_text} before remi "
        f'answers one every {pace}.'
    )


def _questions_left(limits: AskLimits, usage: AskUsage) -> int:
    if usage.tokens >= limits.tokens_soft_cap:
        message = f'{usage.tokens} tokens leaves no full-speed question under the soft cap'
        raise ValueError(message)

    tokens_average = limits.tokens_estimate

    if usage.question_count > 0:
        tokens_average = max(1, usage.tokens // usage.question_count)

    left = max(1, (limits.tokens_soft_cap - usage.tokens) // tokens_average)

    if left > limits.tokens_soft_cap:
        message = f'{left} questions left is more than the soft cap of {limits.tokens_soft_cap}'
        raise RuntimeError(message)

    return left


def _seconds_until(*, moment: datetime, now: datetime) -> int:
    if moment.tzinfo is None:
        message = f'moment must carry a time zone: {moment!r}'
        raise ValueError(message)

    if now.tzinfo is None:
        message = f'now must carry a time zone: {now!r}'
        raise ValueError(message)

    remaining = (moment - now).total_seconds()

    if remaining <= 0:
        return 0

    return math.ceil(remaining)


def _usage_validate(*, limits: AskLimits, now: datetime, usage: AskUsage) -> None:
    if now.tzinfo is None:
        message = f'now must carry a time zone: {now!r}'
        raise ValueError(message)

    if usage.question_count < 0:
        message = f'question_count must not be negative: {usage.question_count}'
        raise ValueError(message)

    if usage.tokens < 0:
        message = f'tokens must not be negative: {usage.tokens}'
        raise ValueError(message)

    if len(usage.asked_burst) > min(limits.burst_count, usage.question_count):
        message = f'{len(usage.asked_burst)} questions in the burst is more than were asked'
        raise ValueError(message)

    if list(usage.asked_burst) != sorted(usage.asked_burst):
        message = 'the questions in the burst must be in the order they were asked'
        raise ValueError(message)

    burst_start = now - timedelta(seconds=limits.burst_seconds)

    if any(not burst_start < asked <= now for asked in usage.asked_burst):
        message = 'a question in the burst was asked outside the burst window'
        raise ValueError(message)

    if (usage.question_count == 0) != (usage.asked_last is None):
        message = f'{usage.question_count} questions disagree with the last question asked'
        raise ValueError(message)

    if usage.question_count == 0:
        if usage.tokens > 0:
            message = f'{usage.tokens} tokens were counted without a question'
            raise ValueError(message)

    if usage.asked_burst:
        if usage.asked_last != usage.asked_burst[-1]:
            message = 'the last question asked is not the newest question in the burst'
            raise ValueError(message)


def _wait_burst_seconds(*, limits: AskLimits, now: datetime, usage: AskUsage) -> int:
    if now.tzinfo is None:
        message = f'now must carry a time zone: {now!r}'
        raise ValueError(message)

    if len(usage.asked_burst) > limits.burst_count:
        message = f'{len(usage.asked_burst)} questions overfill a burst of {limits.burst_count}'
        raise ValueError(message)

    if len(usage.asked_burst) < limits.burst_count:
        return 0

    aged_out = usage.asked_burst[0] + timedelta(seconds=limits.burst_seconds)

    return _seconds_until(moment=aged_out, now=now)


def _wait_pace_seconds(*, limits: AskLimits, now: datetime, usage: AskUsage) -> int:
    if now.tzinfo is None:
        message = f'now must carry a time zone: {now!r}'
        raise ValueError(message)

    if limits.pace_seconds <= 0:
        message = f'the pace must be positive: {limits.pace_seconds}'
        raise ValueError(message)

    if usage.tokens < 0:
        message = f'tokens must not be negative: {usage.tokens}'
        raise ValueError(message)

    if usage.tokens < limits.tokens_soft_cap:
        return 0

    if usage.asked_last is None:
        message = f'{usage.tokens} tokens were counted without a question'
        raise ValueError(message)

    paced = usage.asked_last + timedelta(seconds=limits.pace_seconds)

    return _seconds_until(moment=paced, now=now)


def _wait_text(seconds: int) -> str:
    if seconds <= 0:
        message = f'seconds must be positive: {seconds}'
        raise ValueError(message)

    if seconds < SECONDS_PER_MINUTE:
        return 'in under a minute'

    return f'in about {_minutes_text(seconds)}'


def ask_limits() -> AskLimits:
    limits = AskLimits(
        burst_count=settings.REMI_ASK_BURST_COUNT,
        burst_seconds=settings.REMI_ASK_BURST_SECONDS,
        pace_seconds=settings.REMI_ASK_PACE_SECONDS,
        tokens_estimate=settings.REMI_ASK_TOKENS_ESTIMATE,
        tokens_soft_cap=settings.REMI_ASK_TOKENS_SOFT_CAP,
        window_days=settings.REMI_ASK_WINDOW_DAYS,
    )

    _limits_validate(limits)

    return limits


def ask_pace(*, limits: AskLimits, now: datetime, usage: AskUsage) -> AskPace:
    if not isinstance(limits, AskLimits):
        message = f'limits must be AskLimits: {type(limits).__name__}'
        raise TypeError(message)

    if not isinstance(usage, AskUsage):
        message = f'usage must be AskUsage: {type(usage).__name__}'
        raise TypeError(message)

    if not isinstance(now, datetime):
        message = f'now must be a datetime: {type(now).__name__}'
        raise TypeError(message)

    _limits_validate(limits)
    _usage_validate(limits=limits, now=now, usage=usage)

    wait_burst = _wait_burst_seconds(limits=limits, now=now, usage=usage)
    wait_pace = _wait_pace_seconds(limits=limits, now=now, usage=usage)

    if max(wait_burst, wait_pace) == 0:
        return AskPace(notice=_notice(limits, usage), wait_seconds=0)

    if wait_burst >= wait_pace:
        notice = (
            f'You have asked {limits.burst_count} questions in the last '
            f'{_minutes_text(limits.burst_seconds)}, so remi is pacing them. This answer '
            f'starts {_wait_text(wait_burst)}.'
        )

        return AskPace(notice=notice, wait_seconds=wait_burst)

    notice = (
        f'You have asked a lot this month, so remi answers one question every '
        f'{_minutes_text(limits.pace_seconds)}. This answer starts {_wait_text(wait_pace)}.'
    )

    return AskPace(notice=notice, wait_seconds=wait_pace)
