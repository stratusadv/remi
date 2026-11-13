from __future__ import annotations

import pytest

from typing_extensions import TYPE_CHECKING
from urllib.parse import urlencode

from app.account.models import Account
from app.api.v1.api import THROTTLE_RATE_ANONYMOUS
from app.api.v1.funnel.router import THROTTLE_RATE_BEACON
from harness.api import ACCOUNT_PATH, BEACON_CONTENT_TYPE, FUNNEL_VISIT_PATH, api_post

if TYPE_CHECKING:
    from django.test import Client


pytestmark = pytest.mark.django_db


def test_anonymous_requests_beyond_the_rate_are_throttled_with_a_retry_delay(
    client: Client,
) -> None:
    request_count_max = int(THROTTLE_RATE_ANONYMOUS.split('/')[0])

    for index in range(request_count_max):
        body = {'email': f'person{index}@example.com', 'name': 'Avery', 'promo_code': ''}
        response = api_post(client, ACCOUNT_PATH, body=body)

        assert response.status_code == 201, index

    body_over = {'email': 'over@example.com', 'name': 'Avery', 'promo_code': ''}
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


def test_api_publishes_no_schema_or_documentation(client: Client) -> None:
    for path in ('/api/v1/docs', '/api/v1/openapi.json'):
        assert client.get(path).status_code == 404, path
