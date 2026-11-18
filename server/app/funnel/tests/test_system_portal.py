from __future__ import annotations

import re

import pytest

from decimal import Decimal
from pathlib import Path
from typing_extensions import TYPE_CHECKING, Any

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
REFERENCE_DOWNLOAD = 'remi:acquisition:click:download'

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


def _purchase_paid(world: World, token: str) -> dict[str, Any]:
    assert token != ''
    assert PURCHASE_HOURS > 0

    checkout = {'hours': PURCHASE_HOURS}
    started = remi_post(world, '/api/v1/account/checkout/', checkout, token=token)
    pay = {'session_id': started.json()['session_id']}
    paid = fakes_control(world, '/control/stripe/pay', pay)
    finished = remi_post(world, '/api/v1/account/checkout/finish/', pay, token=token)

    assert paid['webhook_status'] == 200
    assert finished.json()['paid'] is True

    return finished.json()


def test_the_portal_holds_every_statistic_and_subdomain_remi_records(
    settings: Settings,
    world_live: World,
) -> None:
    settings.DJANGO_SPIRE_REMOTE_API_KEY = world_live.descriptor['portal_api_key']
    settings.DJANGO_SPIRE_REMOTE_API_URL = f'{world_live.descriptor["portal_url"]}/ds'
    summary = RemiMetric.check()

    assert summary.missing == []
    assert summary.errors == []


def test_a_conference_journey_lands_each_of_its_references_in_the_portal(
    world_live: World,
) -> None:
    before = portal_totals(world_live)
    address = address_unique('journey')
    landing = {'campaign': 'general', 'page': 'landing'}
    promo = {'campaign': 'wib', 'page': 'promo'}
    email = {'campaign': 'wib', 'email': address}

    assert all(total >= 0 for total in before.values())

    clicked_landing = remi_beacon(world_live, '/api/v1/funnel/click/', landing)
    clicked_promo = remi_beacon(world_live, '/api/v1/funnel/click/', promo)
    emailed = remi_beacon(world_live, '/api/v1/funnel/email/', email)

    assert clicked_landing.status == 204
    assert clicked_promo.status == 204
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
    action = {'action': 'new-chat'}
    acted = remi_post(world_live, '/api/v1/account/action/', action, token=token)

    assert charged.status == 200
    assert acted.status == 204

    finished = _purchase_paid(world_live, token)

    expected = {
        'remi:acquisition:click:download': Decimal(1),
        'remi:acquisition:click:download:windows': Decimal(1),
        'remi:acquisition:click:landing': Decimal(1),
        'remi:acquisition:click:wib:download': Decimal(1),
        'remi:acquisition:click:wib:promo': Decimal(1),
        'remi:acquisition:signup:completed': Decimal(1),
        'remi:acquisition:signup:wib:promo-code': Decimal(1),
        'remi:action:hours-transcribed': Decimal('0.5'),
        'remi:action:meeting-transcribed': Decimal(1),
        'remi:action:new-chat': Decimal(1),
        'remi:action:purchase-hours': Decimal(1),
    }

    portal_totals_wait(world_live, before=before, expected=expected)

    after = portal_totals(world_live)
    qualifiers = ('linux', 'mac', 'windows')
    platforms = [after.get(f'{REFERENCE_DOWNLOAD}:{qualifier}', 0) for qualifier in qualifiers]
    balance_seconds = (50 + PURCHASE_HOURS) * 3600 - CHARGE_SECONDS

    assert after[REFERENCE_DOWNLOAD] == sum(platforms)
    assert finished['account']['balance_seconds'] == balance_seconds


def test_a_one_second_recording_keeps_its_hours_to_four_places_in_the_portal(
    world_live: World,
) -> None:
    before = portal_totals(world_live)
    token = remi_signup(world_live, email=address_unique('second'), promo_code='FRIEND')
    charge = {'job_id': 'e3b0c44298fc1c149afbf4c8996fb924', 'seconds': 1}
    charged = remi_post(world_live, '/api/v1/account/charge/', charge, token=token)

    assert charged.status == 200

    expected = {
        'remi:acquisition:signup:completed': Decimal(1),
        'remi:action:hours-transcribed': Decimal('0.0003'),
        'remi:action:meeting-transcribed': Decimal(1),
    }

    portal_totals_wait(world_live, before=before, expected=expected)


def test_remote_metric_failures_are_only_the_known_django_spire_log(world_live: World) -> None:
    log_text = Path(world_live.remi.log_path).read_text(errors='replace')

    assert _metric_failures_unknown(log_text) == []
