from __future__ import annotations

import datetime
import time
import uuid

from decimal import Decimal
from typing_extensions import TYPE_CHECKING, Any
from urllib.parse import urlencode

from app.funnel.metric import (
    METRIC_DOMAIN_KEY,
    METRIC_GROUP_KEY,
    METRIC_SUB_DOMAIN_KEY,
    MetricStatistic,
)
from harness.world.http import Reply, http_json, http_request

if TYPE_CHECKING:
    from harness.world.world import World


BEACON_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=UTF-8'
PORTAL_DAY_OFFSETS = (-1, 0, 1)
PORTAL_PAGE_COUNT_MAX = 20
PORTAL_PAGE_SIZE = 5000
PORTAL_POLL_SECONDS = 0.25
PORTAL_REFERENCE_PREFIX = f'{METRIC_DOMAIN_KEY}:'
PORTAL_WAIT_SECONDS = 30.0


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


def portal_day_totals(
    world: World,
    *,
    day: datetime.date,
    statistic: MetricStatistic,
) -> dict[str, Decimal]:
    if not isinstance(day, datetime.date):
        message = f'day must be a date, not {type(day).__name__}'
        raise TypeError(message)

    if not isinstance(statistic, MetricStatistic):
        message = f'statistic must be a MetricStatistic: {statistic!r}'
        raise TypeError(message)

    statistic_key = f'{METRIC_DOMAIN_KEY}--{METRIC_GROUP_KEY}--{statistic.value}'
    base = f'{world.descriptor["portal_url"]}/ds/api/v1/metric/domain/statistic'
    headers = {'X-API-Key': str(world.descriptor['portal_api_key'])}
    totals: dict[str, Decimal] = {}

    for page_index in range(PORTAL_PAGE_COUNT_MAX):
        fields = {
            'limit': str(PORTAL_PAGE_SIZE),
            'offset': str(page_index * PORTAL_PAGE_SIZE),
            'sub_domain_key': f'{METRIC_DOMAIN_KEY}--{METRIC_SUB_DOMAIN_KEY}',
            'value_date': day.isoformat(),
        }

        query = urlencode(fields)
        reply = http_request(f'{base}/{statistic_key}/values?{query}', headers=headers)

        if reply.status != 200:
            message = f'the portal answered {reply.status} for {statistic_key}: {reply.body!r}'
            raise AssertionError(message)

        values = reply.json()

        for value in values:
            reference = str(value['reference'])
            totals[reference] = totals.get(reference, Decimal(0)) + Decimal(value['value'])

        if len(values) < PORTAL_PAGE_SIZE:
            return totals

    message = (
        f'the portal holds over {PORTAL_PAGE_COUNT_MAX * PORTAL_PAGE_SIZE} values '
        f'of {statistic_key} on {day}'
    )

    raise AssertionError(message)


def portal_totals(world: World) -> dict[str, Decimal]:
    today = datetime.datetime.now(tz=datetime.UTC).date()
    totals: dict[str, Decimal] = {}

    for statistic in MetricStatistic:
        for day_offset in PORTAL_DAY_OFFSETS:
            day = today + datetime.timedelta(days=day_offset)
            day_totals = portal_day_totals(world, day=day, statistic=statistic)

            for reference, total in day_totals.items():
                totals[reference] = totals.get(reference, Decimal(0)) + total

    return totals


def portal_totals_wait(
    world: World,
    *,
    before: dict[str, Decimal],
    expected: dict[str, Decimal],
) -> dict[str, Decimal]:
    if not isinstance(before, dict):
        message = f'before must be a dict, not {type(before).__name__}'
        raise TypeError(message)

    if not isinstance(expected, dict):
        message = f'expected must be a dict, not {type(expected).__name__}'
        raise TypeError(message)

    for reference, delta in expected.items():
        if not reference.startswith(PORTAL_REFERENCE_PREFIX):
            message = f'expected names a reference outside remi: {reference!r}'
            raise ValueError(message)

        if delta == 0:
            message = f'expected names {reference} with no change'
            raise ValueError(message)

    deadline = time.monotonic() + PORTAL_WAIT_SECONDS
    deltas: dict[str, Decimal] = {}

    while time.monotonic() < deadline:
        after = portal_totals(world)
        deltas = {}

        for reference in sorted(before.keys() | after.keys()):
            delta = after.get(reference, Decimal(0)) - before.get(reference, Decimal(0))

            if delta != 0:
                deltas[reference] = delta

        if deltas == expected:
            return deltas

        time.sleep(PORTAL_POLL_SECONDS)

    message = f'the portal moved by {deltas}, not {expected}'
    raise AssertionError(message)
