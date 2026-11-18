from __future__ import annotations

import logging

import pytest

from typing_extensions import TYPE_CHECKING
from urllib.parse import urlencode

from django.db import ProgrammingError

from app.account.models import Account
from app.api.v1.api import SERVER_ERROR_MESSAGE, THROTTLE_RATE_ANONYMOUS
from app.api.v1.funnel import router as funnel_router
from app.api.v1.funnel.router import THROTTLE_RATE_BEACON
from harness.api import ACCOUNT_PATH, BEACON_CONTENT_TYPE, FUNNEL_VISIT_PATH, api_post

if TYPE_CHECKING:
    from pytest_django.fixtures import Settings

    from django.test import Client


DETAIL_BROKEN = 'column account.is_complimentary does not exist'
LOGGER_API = 'app.api.v1.api'
pytestmark = pytest.mark.django_db


def _visit_record_broken(*, campaign: str, source: str) -> None:
    assert campaign == 'wib'
    assert source == 'qr'

    raise ProgrammingError(DETAIL_BROKEN)


def test_anonymous_requests_beyond_the_rate_are_throttled_with_a_retry_delay(
    client: Client,
) -> None:
    request_count_max = int(THROTTLE_RATE_ANONYMOUS.split('/')[0])

    for index in range(request_count_max):
        body = {
            'email': f'person{index}@example.com',
            'name': 'Avery',
            'promo_code': '',
            'region': 'CA-AB',
        }

        response = api_post(client, ACCOUNT_PATH, body=body)

        assert response.status_code == 201, index

    body_over = {'email': 'over@example.com', 'name': 'Avery', 'promo_code': '', 'region': 'CA-AB'}
    throttled = api_post(client, ACCOUNT_PATH, body=body_over)
    message = 'Too many requests. Try again in a minute.'
    error = {'code': 'throttled', 'message': message, 'type': 'billing_error'}

    assert throttled.status_code == 429
    assert throttled.json() == {'error': error}
    assert int(throttled['Retry-After']) > 0
    assert Account.objects.count() == request_count_max


def test_beacons_from_one_address_count_past_the_sign_up_rate_up_to_their_own(
    client: Client,
) -> None:
    rate_anonymous = int(THROTTLE_RATE_ANONYMOUS.split('/')[0])
    rate_beacon = int(THROTTLE_RATE_BEACON.split('/')[0])
    fields = {'campaign': 'wib', 'source': 'qr'}
    body = urlencode(fields)

    for index in range(rate_beacon):
        response = client.post(FUNNEL_VISIT_PATH, data=body, content_type=BEACON_CONTENT_TYPE)

        assert response.status_code == 204, index

    throttled = client.post(FUNNEL_VISIT_PATH, data=body, content_type=BEACON_CONTENT_TYPE)

    assert throttled.status_code == 429
    assert throttled.json()['error']['code'] == 'throttled'
    assert rate_beacon > rate_anonymous


def test_beacons_leave_the_sign_up_allowance_of_their_address_untouched(
    client: Client,
) -> None:
    rate_anonymous = int(THROTTLE_RATE_ANONYMOUS.split('/')[0])
    fields = {'campaign': 'wib', 'source': 'qr'}
    body = urlencode(fields)

    body_account = {
        'email': 'avery@example.com',
        'name': 'Avery',
        'promo_code': '',
        'region': 'CA-AB',
    }

    for index in range(rate_anonymous):
        response = client.post(FUNNEL_VISIT_PATH, data=body, content_type=BEACON_CONTENT_TYPE)

        assert response.status_code == 204, index

    signed_up = api_post(client, ACCOUNT_PATH, body=body_account)

    assert signed_up.status_code == 201
    assert Account.objects.count() == 1


def test_api_publishes_no_schema_or_documentation(client: Client) -> None:
    for path in ('/api/v1/docs', '/api/v1/openapi.json'):
        response = client.get(path)

        assert response.status_code == 404, path


def test_an_unhandled_error_is_logged_with_its_traceback_and_answered_without_it(
    caplog: pytest.LogCaptureFixture,
    client: Client,
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
) -> None:
    fields = {'campaign': 'wib', 'source': 'qr'}
    body = urlencode(fields)
    error = {'code': 'server_error', 'message': SERVER_ERROR_MESSAGE, 'type': 'billing_error'}

    monkeypatch.setattr(funnel_router, 'funnel_visit_record', _visit_record_broken)

    for debug in (False, True):
        settings.DEBUG = debug
        caplog.clear()

        with caplog.at_level(logging.ERROR, logger=LOGGER_API):
            response = client.post(FUNNEL_VISIT_PATH, data=body, content_type=BEACON_CONTENT_TYPE)

        records = [record for record in caplog.records if record.name == LOGGER_API]

        assert response.status_code == 500, debug
        assert response.json() == {'error': error}, debug
        assert DETAIL_BROKEN not in response.content.decode(), debug
        assert len(records) == 1, debug
        assert records[0].exc_info is not None, debug
        assert DETAIL_BROKEN in caplog.text, debug
