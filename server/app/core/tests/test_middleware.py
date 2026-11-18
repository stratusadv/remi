from __future__ import annotations

import ipaddress
import logging
import re

import pytest

from typing_extensions import TYPE_CHECKING

from django.http import HttpResponse
from django.test import RequestFactory

from app.account.models import Account
from app.api.v1.api import THROTTLE_RATE_ANONYMOUS
from app.core.middleware import RemoteAddressMiddleware
from harness.api import ACCOUNT_PATH, account_create, account_get

if TYPE_CHECKING:
    from pytest_django.fixtures import Settings

    from django.http import HttpRequest
    from django.test import Client
    from django.test.client import _MonkeyPatchedWSGIResponse


pytestmark = pytest.mark.django_db
CLIENT_ADDRESS_FIRST = '203.0.113.10'
CLIENT_ADDRESS_SECOND = '198.51.100.20'
FORWARDED_FORGED = '192.0.2.99, 10.244.3.17'
INGRESS_ADDRESS = '10.244.3.17'
LOGGER_REQUEST = 'app.core.middleware'
MIDDLEWARE_REMOTE_ADDRESS = 'app.core.middleware.RemoteAddressMiddleware'
REQUEST_LOG_PATTERN = r'(GET|POST) /api/v1/account/ (\d{3}) in \d+ ms for account (\w+)'

REMOTE_ADDRESS_CASES = (
    ('203.0.113.10', '203.0.113.10'),
    (' 203.0.113.10 ', '203.0.113.10'),
    ('2001:DB8:0:0:0:0:0:1', '2001:db8::1'),
    ('', '127.0.0.1'),
    ('not-an-address', '127.0.0.1'),
    ('203.0.113.10, 10.244.3.17', '127.0.0.1'),
    ('256.0.113.10', '127.0.0.1'),
)


def _account_post(
    client: Client,
    *,
    email: str,
    headers: dict[str, str],
) -> _MonkeyPatchedWSGIResponse:
    assert '@' in email
    assert headers.keys() == {'do-connecting-ip', 'x-forwarded-for'}

    body = {'email': email, 'name': 'Avery', 'promo_code': '', 'region': 'CA-AB'}
    return client.post(ACCOUNT_PATH, data=body, content_type='application/json', headers=headers)


def _response_empty(request: HttpRequest) -> HttpResponse:
    address = request.META['REMOTE_ADDR']

    assert str(ipaddress.ip_address(address)) == address

    return HttpResponse()


def test_anonymous_clients_behind_one_ingress_are_throttled_apart(
    client: Client,
    settings: Settings,
) -> None:
    settings.MIDDLEWARE = [MIDDLEWARE_REMOTE_ADDRESS, *settings.MIDDLEWARE]
    settings.NINJA_NUM_PROXIES = 0

    request_count_max = int(THROTTLE_RATE_ANONYMOUS.split('/')[0])
    headers_first = {'do-connecting-ip': CLIENT_ADDRESS_FIRST, 'x-forwarded-for': INGRESS_ADDRESS}

    for index in range(request_count_max):
        email = f'person{index}@example.com'
        response = _account_post(client, email=email, headers=headers_first)

        assert response.status_code == 201, index

    headers_forged = {'do-connecting-ip': CLIENT_ADDRESS_FIRST, 'x-forwarded-for': FORWARDED_FORGED}
    headers_second = {'do-connecting-ip': CLIENT_ADDRESS_SECOND, 'x-forwarded-for': INGRESS_ADDRESS}
    throttled = _account_post(client, email='over@example.com', headers=headers_first)
    forged = _account_post(client, email='forged@example.com', headers=headers_forged)
    second = _account_post(client, email='second@example.com', headers=headers_second)

    assert throttled.status_code == 429
    assert forged.status_code == 429
    assert second.status_code == 201


def test_remote_address_takes_the_connecting_ip_only_when_it_is_one_address() -> None:
    factory = RequestFactory()
    middleware = RemoteAddressMiddleware(_response_empty)

    for header, address_expected in REMOTE_ADDRESS_CASES:
        headers = {'do-connecting-ip': header}
        request = factory.get('/', headers=headers)
        response = middleware(request)

        assert response.status_code == 200, header
        assert request.META['REMOTE_ADDR'] == address_expected, header


def test_each_request_is_logged_with_its_method_path_status_duration_and_account(
    caplog: pytest.LogCaptureFixture,
    client: Client,
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER_REQUEST)

    token = account_create(client)
    account = Account.objects.get(email='avery@example.com')
    refused = client.get(ACCOUNT_PATH)
    detail = account_get(client, token)

    lines = [record.getMessage() for record in caplog.records if record.name == LOGGER_REQUEST]
    matches = [re.fullmatch(REQUEST_LOG_PATTERN, line) for line in lines]
    fields = [match.groups() for match in matches if match is not None]

    expected = [
        ('POST', '201', 'None'),
        ('GET', '401', 'None'),
        ('GET', '200', str(account.pk)),
    ]

    assert refused.status_code == 401
    assert detail['email'] == account.email
    assert len(lines) == 3
    assert fields == expected
