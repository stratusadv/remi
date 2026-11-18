from __future__ import annotations

import re

import pytest

from decimal import Decimal
from pathlib import Path
from typing_extensions import TYPE_CHECKING

from app.funnel.metric import RemiMetric
from harness.world.client import (
    address_unique,
    fakes_control,
    fakes_state,
    portal_totals,
    portal_totals_wait,
    remi_beacon,
    remi_post,
    remi_signup,
)

if TYPE_CHECKING:
    from pytest_django.fixtures import Settings

    from harness.world.world import World


CHARGE_SECONDS = 1800
CODE_PATTERN = re.compile(r'WIB-[23456789A-HJKMNP-TV-Z]{4}-[23456789A-HJKMNP-TV-Z]{4}')
EXCEPTION_LINE_PATTERN = re.compile(r'^[A-Za-z_][\w.]*(?:Error|Exception): ')
JOB_ID = '5a1f0e8a9b2d7e6f5a4b3c2d1e0f9a8b'
LOOKAHEAD_LINES = 40
METRIC_FAILED = 'Metric record failed'
METRIC_FAILED_KNOWN = "AttributeError: 'dict' object has no attribute 'json'"
PURCHASE_HOURS = 50
PURCHASE_PRICE = Decimal('50.00')

pytestmark = pytest.mark.system


def _metric_failures_unknown(log_text: str) -> list[str]:
    assert log_text

    lines = log_text.splitlines()
    unknown = []

    for index, line in enumerate(lines):
        if METRIC_FAILED not in line:
            continue

        following = lines[index + 1 : index + LOOKAHEAD_LINES]
        raised = [text for text in following if EXCEPTION_LINE_PATTERN.match(text)]
        unexplained = raised[:1] != [METRIC_FAILED_KNOWN]

        if unexplained:
            unknown.append(f'{line} -> {raised[:1]}')

    return unknown


def _wib(statistic: str) -> tuple[str, str]:
    assert statistic.partition('--')[0] in ('funnel', 'sales', 'usage')

    return (f'remi--{statistic}', 'wib')


def test_the_portal_holds_every_statistic_and_campaign_remi_records(
    settings: Settings,
    world_live: World,
) -> None:
    settings.DJANGO_SPIRE_REMOTE_API_KEY = world_live.descriptor['portal_api_key']
    settings.DJANGO_SPIRE_REMOTE_API_URL = f'{world_live.descriptor["portal_url"]}/ds'
    summary = RemiMetric.check()

    assert summary.missing == []
    assert summary.errors == []


def test_a_conference_journey_lands_every_statistic_in_the_portal_under_its_campaign(
    world_live: World,
) -> None:
    before = portal_totals(world_live)
    address = address_unique('journey')
    visit = {'campaign': 'wib', 'source': 'qr'}
    email = {'campaign': 'wib', 'email': address}

    assert all(total >= 0 for total in before.values())

    visited = remi_beacon(world_live, '/api/v1/funnel/visit/', visit)
    emailed = remi_beacon(world_live, '/api/v1/funnel/email/', email)

    assert visited.status == 204
    assert emailed.status == 204

    messages = [
        message
        for message in fakes_state(world_live)['sendgrid_messages']
        if message['to'] == [address]
    ]

    code = CODE_PATTERN.search(messages[-1]['text'])

    assert code is not None

    download = {'campaign': 'wib', 'code': code.group(), 'platform': 'windows'}
    downloaded = remi_beacon(world_live, '/api/v1/funnel/download/', download)

    assert downloaded.status == 204

    token = remi_signup(world_live, email=address, promo_code=code.group().lower())
    charge = {'job_id': JOB_ID, 'seconds': CHARGE_SECONDS}
    charged = remi_post(world_live, '/api/v1/account/charge/', charge, token=token)

    assert charged.status == 200

    checkout = {'hours': PURCHASE_HOURS}
    started = remi_post(world_live, '/api/v1/account/checkout/', checkout, token=token)
    session_id = started.json()['session_id']
    paid = fakes_control(world_live, '/control/stripe/pay', {'session_id': session_id})
    finish = {'session_id': session_id}
    finished = remi_post(world_live, '/api/v1/account/checkout/finish/', finish, token=token)

    assert paid['webhook_status'] == 200
    assert finished.json()['paid'] is True

    expected = {
        _wib('funnel--activations'): Decimal(1),
        _wib('funnel--checkouts'): Decimal(1),
        _wib('funnel--downloads'): Decimal(1),
        _wib('funnel--paying-clients'): Decimal(1),
        _wib('funnel--promos'): Decimal(1),
        _wib('funnel--purchases'): Decimal(1),
        _wib('funnel--scans'): Decimal(1),
        _wib('funnel--signups'): Decimal(1),
        _wib('funnel--visits'): Decimal(1),
        _wib('sales--revenue'): PURCHASE_PRICE,
        _wib('usage--hours'): Decimal('0.5'),
        _wib('usage--meetings'): Decimal(1),
    }

    portal_totals_wait(world_live, before=before, expected=expected)

    balance_seconds = (50 + PURCHASE_HOURS) * 3600 - CHARGE_SECONDS

    assert finished.json()['account']['balance_seconds'] == balance_seconds


def test_a_one_second_recording_keeps_its_hours_to_four_places_in_the_portal(
    world_live: World,
) -> None:
    before = portal_totals(world_live)
    token = remi_signup(world_live, email=address_unique('second'), promo_code='FRIEND')
    charge = {'job_id': 'e3b0c44298fc1c149afbf4c8996fb924', 'seconds': 1}
    charged = remi_post(world_live, '/api/v1/account/charge/', charge, token=token)

    assert charged.status == 200

    expected = {
        ('remi--funnel--activations', 'general'): Decimal(1),
        ('remi--funnel--promos', 'general'): Decimal(1),
        ('remi--funnel--signups', 'general'): Decimal(1),
        ('remi--usage--hours', 'general'): Decimal('0.0003'),
        ('remi--usage--meetings', 'general'): Decimal(1),
    }

    portal_totals_wait(world_live, before=before, expected=expected)


def test_remote_metric_failures_are_only_the_known_django_spire_log(world_live: World) -> None:
    log_text = Path(world_live.remi.log_path).read_text(errors='replace')

    assert _metric_failures_unknown(log_text) == []
