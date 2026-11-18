from __future__ import annotations

import datetime
import time
import uuid

from decimal import Decimal
from typing_extensions import TYPE_CHECKING, Any
from urllib.parse import urlencode

from app.funnel.choices import CampaignChoices
from app.funnel.metric import METRIC_DOMAIN_KEY, METRIC_GROUP_KEYS
from harness.world.http import Reply, http_json, http_request

if TYPE_CHECKING:
    from harness.world.world import World


BEACON_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=UTF-8'
PORTAL_POLL_SECONDS = 0.25
PORTAL_WAIT_SECONDS = 30.0
PORTAL_WINDOW = datetime.timedelta(days=1)


def statistic_keys() -> list[str]:
    return sorted(
        f'{METRIC_DOMAIN_KEY}--{group_key}--{statistic.value}'
        for choices, group_key in METRIC_GROUP_KEYS.items()
        for statistic in choices
    )


def address_unique(prefix: str) -> str:
    if not isinstance(prefix, str):
        message = f'prefix must be a str, not {type(prefix).__name__}'
        raise TypeError(message)

    return f'{prefix}-{uuid.uuid4().hex[:12]}@example.com'


def remi_url(world: World, path: str) -> str:
    if not path.startswith('/'):
        message = f'path must start with a slash: {path!r}'
        raise ValueError(message)

    return f'{world.descriptor["remi_url"]}{path}'


def remi_post(world: World, path: str, payload: object, *, token: str = '') -> Reply:
    if not path.startswith('/'):
        message = f'path must start with a slash: {path!r}'
        raise ValueError(message)

    if not isinstance(payload, dict | list | tuple | str | int | float | None):
        message = f'payload must be JSON data or None, not {type(payload).__name__}'
        raise TypeError(message)

    if '\r' in token:
        message = f'token must not carry a carriage return: {token!r}'
        raise ValueError(message)

    if '\n' in token:
        message = f'token must not carry a line feed: {token!r}'
        raise ValueError(message)

    headers = {} if token == '' else {'Authorization': f'Bearer {token}'}
    return http_json(remi_url(world, path), headers=headers, method='POST', payload=payload)


def remi_get(world: World, path: str, *, token: str = '') -> Reply:
    if not path.startswith('/'):
        message = f'path must start with a slash: {path!r}'
        raise ValueError(message)

    if '\r' in token:
        message = f'token must not carry a carriage return: {token!r}'
        raise ValueError(message)

    if '\n' in token:
        message = f'token must not carry a line feed: {token!r}'
        raise ValueError(message)

    headers = {} if token == '' else {'Authorization': f'Bearer {token}'}
    return http_request(remi_url(world, path), headers=headers)


def remi_beacon(world: World, path: str, fields: dict[str, str]) -> Reply:
    if not path.startswith('/'):
        message = f'path must start with a slash: {path!r}'
        raise ValueError(message)

    if not isinstance(fields, dict):
        message = f'fields must be a dict, not {type(fields).__name__}'
        raise TypeError(message)

    body = urlencode(fields).encode()
    headers = {'Content-Type': BEACON_CONTENT_TYPE}

    return http_request(remi_url(world, path), body=body, headers=headers, method='POST')


def remi_signup(world: World, *, email: str, promo_code: str = '') -> str:
    if not isinstance(email, str):
        message = f'email must be a str, not {type(email).__name__}'
        raise TypeError(message)

    if not isinstance(promo_code, str):
        message = f'promo_code must be a str, not {type(promo_code).__name__}'
        raise TypeError(message)

    payload = {'email': email, 'name': 'World Tester', 'promo_code': promo_code, 'region': 'CA-AB'}
    reply = remi_post(world, '/api/v1/account/', payload)

    if reply.status != 201:
        message = f'signing up {email} answered {reply.status}: {reply.body!r}'
        raise AssertionError(message)

    return reply.json()['token']


def fakes_state(world: World) -> dict[str, Any]:
    return http_request(f'{world.descriptor["fakes_url"]}/control/state').json()


def fakes_control(world: World, path: str, payload: object) -> dict[str, Any]:
    if not path.startswith('/control/'):
        message = f'path must be a control path of the fakes: {path!r}'
        raise ValueError(message)

    if not isinstance(payload, dict):
        message = f'payload must be a JSON object, not {type(payload).__name__}'
        raise TypeError(message)

    reply = http_json(f'{world.descriptor["fakes_url"]}{path}', method='POST', payload=payload)

    if reply.status != 200:
        message = f'the fakes refused {path}: {reply.body!r}'
        raise AssertionError(message)

    return reply.json()


def portal_total(world: World, *, campaign: str, statistic: str) -> Decimal:
    if campaign not in CampaignChoices.values:
        message = f'campaign must be one of {CampaignChoices.values}: {campaign!r}'
        raise ValueError(message)

    if statistic not in statistic_keys():
        message = f'statistic must be a statistic key of remi: {statistic!r}'
        raise ValueError(message)

    today = datetime.datetime.now(tz=datetime.UTC).date()

    fields = {
        'end_date': (today + PORTAL_WINDOW).isoformat(),
        'start_date': (today - PORTAL_WINDOW).isoformat(),
        'sub_domain_key': f'{METRIC_DOMAIN_KEY}--{campaign}',
    }

    query = urlencode(fields)
    base = f'{world.descriptor["portal_url"]}/ds/api/v1/metric/domain/statistic'
    url = f'{base}/{statistic}/summary?{query}'
    headers = {'X-API-Key': str(world.descriptor['portal_api_key'])}
    reply = http_request(url, headers=headers)

    if reply.status != 200:
        message = f'the portal answered {reply.status} for {statistic}: {reply.body!r}'
        raise AssertionError(message)

    totals = reply.json()['totals']
    return sum((Decimal(total) for total in totals.values()), Decimal(0))


def portal_totals(world: World) -> dict[tuple[str, str], Decimal]:
    return {
        (statistic, campaign): portal_total(world, campaign=campaign, statistic=statistic)
        for statistic in statistic_keys()
        for campaign in CampaignChoices.values
    }


def portal_totals_wait(
    world: World,
    *,
    before: dict[tuple[str, str], Decimal],
    expected: dict[tuple[str, str], Decimal],
) -> dict[tuple[str, str], Decimal]:
    if not expected.keys() <= before.keys():
        message = f'expected names totals before does not hold: {expected.keys() - before.keys()}'
        raise ValueError(message)

    deadline = time.monotonic() + PORTAL_WAIT_SECONDS
    deltas: dict[tuple[str, str], Decimal] = {}

    while time.monotonic() < deadline:
        after = portal_totals(world)
        deltas = {key: after[key] - before[key] for key in after if after[key] != before[key]}

        if deltas == expected:
            return deltas

        time.sleep(PORTAL_POLL_SECONDS)

    message = f'the portal moved by {deltas}, not {expected}'
    raise AssertionError(message)
