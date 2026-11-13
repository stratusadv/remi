from __future__ import annotations

import pytest

from datetime import UTC, datetime, timedelta
from typing_extensions import NamedTuple

from app.account.question.pace import AskLimits, AskPace, AskUsage, ask_pace


LIMITS = AskLimits(
    burst_count=5,
    burst_seconds=600,
    pace_seconds=300,
    tokens_estimate=100_000,
    tokens_soft_cap=1_000_000,
    window_days=1,
)

SIMULATION_PAUSE_STEP = 200
SIMULATION_STEPS = 300
START = datetime(2026, 11, 13, 9, 0, tzinfo=UTC)
TOKENS_PER_QUESTION = 100_000


class Asked(NamedTuple):
    moment: datetime
    tokens: int


class Simulation(NamedTuple):
    asked: list[Asked]
    waits_burst: int
    waits_pace: int


def _usage(
    *,
    asked_burst: tuple[datetime, ...] = (),
    question_count: int,
    tokens: int,
) -> AskUsage:
    asked_last = START if question_count > 0 else None

    if asked_burst:
        asked_last = asked_burst[-1]

    return AskUsage(
        asked_burst=asked_burst,
        asked_last=asked_last,
        question_count=question_count,
        tokens=tokens,
    )


def _usage_of(asked: list[Asked], limits: AskLimits, now: datetime) -> AskUsage:
    window_start = now - timedelta(days=limits.window_days)
    burst_start = now - timedelta(seconds=limits.burst_seconds)
    window = [entry for entry in asked if window_start < entry.moment <= now]
    burst = [entry.moment for entry in window if entry.moment > burst_start]

    return AskUsage(
        asked_burst=tuple(burst[-limits.burst_count:]),
        asked_last=window[-1].moment if window else None,
        question_count=len(window),
        tokens=sum(entry.tokens for entry in window),
    )


def _simulate(limits: AskLimits) -> Simulation:
    asked = []
    now = START
    waits_burst = 0
    waits_pace = 0

    for step in range(SIMULATION_STEPS):
        if step == SIMULATION_PAUSE_STEP:
            now += timedelta(days=limits.window_days, hours=1)

        usage = _usage_of(asked, limits, now)
        pace = ask_pace(limits=limits, now=now, usage=usage)

        if pace.wait_seconds == 0:
            entry = Asked(moment=now, tokens=TOKENS_PER_QUESTION)
            asked.append(entry)
            now += timedelta(seconds=1)

            continue

        early = now + timedelta(seconds=pace.wait_seconds - 1)
        pace_early = ask_pace(limits=limits, now=early, usage=_usage_of(asked, limits, early))

        assert pace_early.wait_seconds > 0, now

        if 'questions in the last' in pace.notice:
            waits_burst += 1
        else:
            waits_pace += 1

        now += timedelta(seconds=pace.wait_seconds)

    return Simulation(asked=asked, waits_burst=waits_burst, waits_pace=waits_pace)


def test_an_eager_asker_never_beats_the_burst_or_the_pace_and_returns_to_full_speed() -> None:
    simulation = _simulate(LIMITS)
    moments = [entry.moment for entry in simulation.asked]
    burst = timedelta(seconds=LIMITS.burst_seconds)
    pace = timedelta(seconds=LIMITS.pace_seconds)
    window = timedelta(days=LIMITS.window_days)
    slow_lane = []

    for index, moment in enumerate(moments):
        in_burst = [other for other in moments[: index + 1] if other > moment - burst]
        before = [entry for entry in simulation.asked[:index] if entry.moment > moment - window]
        slow = sum(entry.tokens for entry in before) >= LIMITS.tokens_soft_cap

        assert len(in_burst) <= LIMITS.burst_count, moment

        if slow:
            assert moment - moments[index - 1] >= pace, moment

        slow_lane.append(slow)

    slow_first = slow_lane.index(True)

    assert simulation.waits_burst > 0
    assert simulation.waits_pace > 0
    assert False in slow_lane[slow_first:]


def test_a_question_under_half_the_soft_cap_carries_no_notice() -> None:
    usage = _usage(question_count=4, tokens=LIMITS.tokens_soft_cap // 2 - 1)

    assert ask_pace(limits=LIMITS, now=START, usage=usage) == AskPace(notice='', wait_seconds=0)
    assert ask_pace(limits=LIMITS, now=START, usage=_usage(question_count=0, tokens=0)).notice == ''


def test_a_question_past_half_the_soft_cap_counts_the_full_speed_questions_left() -> None:
    half = _usage(question_count=25, tokens=LIMITS.tokens_soft_cap // 2)
    near = _usage(question_count=1, tokens=LIMITS.tokens_soft_cap - 1)
    pace_half = ask_pace(limits=LIMITS, now=START, usage=half)
    pace_near = ask_pace(limits=LIMITS, now=START, usage=near)

    assert pace_half.wait_seconds == 0
    assert pace_half.notice == (
        "You have used half of this month's full-speed questions. About 25 are left before "
        'remi answers one every 5 minutes.'
    )

    assert pace_near.notice.startswith("You have used half of this month's full-speed questions.")
    assert 'About 1 is left before' in pace_near.notice


def test_a_question_past_the_soft_cap_waits_out_the_pace_and_then_goes_through() -> None:
    usage = _usage(question_count=12, tokens=LIMITS.tokens_soft_cap)
    after_one_minute = START + timedelta(seconds=60)
    after_pace = START + timedelta(seconds=LIMITS.pace_seconds)
    waiting = ask_pace(limits=LIMITS, now=after_one_minute, usage=usage)
    slow = ask_pace(limits=LIMITS, now=after_pace, usage=usage)

    assert waiting.wait_seconds == LIMITS.pace_seconds - 60
    assert waiting.notice == (
        'You have asked a lot this month, so remi answers one question every 5 minutes. '
        'This answer starts in about 4 minutes.'
    )

    assert slow.wait_seconds == 0
    assert slow.notice == (
        'You have asked a lot this month, so remi answers one question every 5 minutes.'
    )


def test_a_full_burst_waits_until_its_oldest_question_leaves_the_burst_window() -> None:
    asked_burst = tuple(START + timedelta(seconds=offset) for offset in (0, 10, 20, 30, 40))
    usage = _usage(asked_burst=asked_burst, question_count=5, tokens=500_000)
    now = START + timedelta(seconds=40.5)
    nearly = START + timedelta(seconds=LIMITS.burst_seconds - 30)
    pace = ask_pace(limits=LIMITS, now=now, usage=usage)
    pace_nearly = ask_pace(limits=LIMITS, now=nearly, usage=usage)

    assert pace.wait_seconds == LIMITS.burst_seconds - 40
    assert pace.notice == (
        'You have asked 5 questions in the last 10 minutes, so remi is pacing them. This answer '
        'starts in about 10 minutes.'
    )

    assert pace_nearly.wait_seconds == 30
    assert pace_nearly.notice.endswith('This answer starts in under a minute.')


def test_usage_and_limits_that_cannot_happen_are_refused() -> None:
    inside = START - timedelta(seconds=10)
    outside = START - timedelta(seconds=LIMITS.burst_seconds)
    naive = START.replace(tzinfo=None)
    disagreeing = AskUsage(asked_burst=(), asked_last=START, question_count=0, tokens=0)
    empty = _usage(question_count=0, tokens=0)
    limits_zero = LIMITS._replace(pace_seconds=0)
    limits_long = LIMITS._replace(burst_seconds=2 * 86_400)

    cases = [
        (LIMITS, START, _usage(question_count=-1, tokens=0), 'question_count must not be'),
        (LIMITS, START, _usage(question_count=1, tokens=-1), 'tokens must not be negative'),
        (LIMITS, START, _usage(asked_burst=(outside,), question_count=1, tokens=1), 'outside'),
        (LIMITS, START, _usage(asked_burst=(START, inside), question_count=2, tokens=1), 'order'),
        (LIMITS, START, _usage(asked_burst=(inside,), question_count=0, tokens=0), 'more than'),
        (LIMITS, START, _usage(question_count=0, tokens=5), 'without a question'),
        (LIMITS, START, disagreeing, 'disagree'),
        (LIMITS, naive, empty, 'time zone'),
        (limits_zero, START, empty, 'pace_seconds must be positive'),
        (limits_long, START, empty, 'outlasts the window'),
    ]

    for limits, now, usage, phrase in cases:
        with pytest.raises(ValueError, match=phrase):
            ask_pace(limits=limits, now=now, usage=usage)
