from __future__ import annotations

import html
import io
import logging
import re
import urllib.error

import pytest

from datetime import timedelta
from http.client import HTTPMessage
from typing_extensions import TYPE_CHECKING
from urllib.parse import urlencode

from django.core.cache import cache
from django.utils import timezone

from app.account.constants import SECONDS_PER_HOUR
from app.api.v1.funnel.router import THROTTLE_RATE_EMAIL
from app.core.mail import SENDGRID_TIMEOUT_SECONDS
from app.funnel import mail
from app.funnel.choices import CampaignChoices
from app.funnel.constants import (
    FUNNEL_PAGE_ORIGIN,
    FUNNEL_PAGE_URL_GENERAL_DOWNLOAD,
    FUNNEL_PAGE_URL_WIB_DOWNLOAD,
)
from app.funnel.promo import FUNNEL_OFFER_UNSET_MESSAGE
from app.promo_code.models import PromoCode
from app.promo_code.tests.factories import create_test_promo_code
from harness.api import (
    ACCOUNT_PATH,
    BEACON_CONTENT_TYPE,
    FUNNEL_EMAIL_PATH,
    FUNNEL_VISIT_PATH,
    account_create,
    account_get,
    api_post,
)
from harness.sendgrid import SENDGRID_API_KEY, SENDGRID_URL

if TYPE_CHECKING:
    from pytest_django.fixtures import Settings

    from django.test import Client
    from django.test.client import _MonkeyPatchedWSGIResponse

    from harness.sendgrid import SendgridFake, SendgridRequest


pytestmark = pytest.mark.django_db
ADDRESS = 'avery@example.com'
ADDRESS_DOMAIN_LONGEST = f'{"b" * 63}.{"c" * 63}.{"d" * 57}.com'
CODE_GROUP = '[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}'
CODE_PATTERN = re.compile(f'WIB-{CODE_GROUP}-{CODE_GROUP}')
LOGGER_MAIL = 'app.funnel.mail'
LOGGER_PROMO = 'app.funnel.promo'
SENDGRID_ERROR_KINDS = ('refused', 'timed_out', 'unreachable')
URL_PATTERN = re.compile(r'https://\S+')
WIB_HOURS = 50


@pytest.fixture(autouse=True)
def wib_offer() -> PromoCode:
    return create_test_promo_code(campaign=CampaignChoices.WIB, code='WIB2026', hours=WIB_HOURS)


def _code_in(request: SendgridRequest) -> str:
    assert 'content' in request.payload

    found = CODE_PATTERN.search(_content(request, 'text/plain'))

    if found is None:
        message = 'the email carries no personal code'
        raise AssertionError(message)

    return found.group()


def _content(request: SendgridRequest, kind: str) -> str:
    assert 'content' in request.payload
    assert kind in ('text/html', 'text/plain')

    content = request.payload['content']

    if not isinstance(content, list):
        message = f'the email content must be a list: {type(content).__name__}'
        raise TypeError(message)

    parts = [part['value'] for part in content if part['type'] == kind]

    if len(parts) != 1:
        message = f'the email carries {len(parts)} {kind} parts'
        raise AssertionError(message)

    return parts[0]


def _download_url(code: str) -> str:
    assert CODE_PATTERN.fullmatch(code)

    query = {'code': code, 'utm_source': 'email'}
    return f'{FUNNEL_PAGE_URL_WIB_DOWNLOAD}?{urlencode(query)}'


def _email_request(client: Client, fields: dict[str, str]) -> _MonkeyPatchedWSGIResponse:
    assert fields.keys() <= {'campaign', 'email', 'name_first', 'name_last'}

    return client.post(FUNNEL_EMAIL_PATH, data=urlencode(fields), content_type=BEACON_CONTENT_TYPE)


def _sendgrid_error(kind: str) -> OSError:
    if kind not in SENDGRID_ERROR_KINDS:
        message = f'no SendGrid error is named {kind!r}'
        raise ValueError(message)

    if kind == 'refused':
        body = io.BytesIO(b'{"errors": [{"message": "The provided authorization is invalid"}]}')
        return urllib.error.HTTPError(SENDGRID_URL, 401, 'Unauthorized', HTTPMessage(), body)

    if kind == 'timed_out':
        return TimeoutError('timed out')

    reason = ConnectionRefusedError(111, 'Connection refused')
    return urllib.error.URLError(reason)


def test_email_carries_a_personal_code_and_the_download_page_to_sendgrid_within_its_timeout(
    client: Client,
    sendgrid_fake: SendgridFake,
) -> None:
    fields = {'campaign': 'wib', 'email': '  Avery@Example.com '}
    response = _email_request(client, fields)
    personal = PromoCode.objects.issued().get()

    assert response.status_code == 204
    assert len(sendgrid_fake.requests) == 1
    assert CODE_PATTERN.fullmatch(personal.code)
    assert personal.email == 'Avery@Example.com'
    assert personal.campaign == CampaignChoices.WIB
    assert personal.hours == WIB_HOURS
    assert personal.redemptions_max == 1

    request = sendgrid_fake.requests[0]
    payload = request.payload
    recipient = {'email': 'Avery@Example.com'}
    personalization = {'subject': 'Your remi code for Women in Business', 'to': [recipient]}

    assert [part['type'] for part in payload['content']] == ['text/plain', 'text/html']
    assert payload['personalizations'] == [personalization]
    assert payload['from'] == {'email': 'noreply@remirememberthat.com', 'name': 'remi'}
    assert payload['tracking_settings']['click_tracking']['enable_text'] is False
    assert payload['mail_settings']['sandbox_mode']['enable'] is False
    assert request.authorization == f'Bearer {SENDGRID_API_KEY}'
    assert request.timeout == SENDGRID_TIMEOUT_SECONDS

    body = _content(request, 'text/plain')
    page = _content(request, 'text/html')
    url = _download_url(personal.code)

    assert url in URL_PATTERN.findall(body)
    assert html.escape(url) in page
    assert personal.code in body
    assert personal.code in page
    assert 'WIB2026' not in body
    assert '{{' not in body
    assert '{{' not in page


def test_email_for_each_campaign_links_its_own_page_on_the_landing_page_origin(
    client: Client,
    sendgrid_fake: SendgridFake,
) -> None:
    for campaign in CampaignChoices.values:
        fields = {'campaign': campaign, 'email': f'{campaign}@example.com'}
        response = _email_request(client, fields)

        assert response.status_code == 204, campaign

    bodies = [_content(request, 'text/plain') for request in sendgrid_fake.requests]
    pages = [_content(request, 'text/html') for request in sendgrid_fake.requests]
    links = [URL_PATTERN.findall(body) for body in bodies]
    personal = PromoCode.objects.issued().get()
    general = f'{FUNNEL_PAGE_URL_GENERAL_DOWNLOAD}?utm_source=email'
    wib = _download_url(personal.code)

    assert sendgrid_fake.recipients() == ['general@example.com', 'wib@example.com']
    assert general in links[0]
    assert wib in links[1]
    assert html.escape(general) in pages[0]
    assert html.escape(wib) in pages[1]
    assert general.startswith(f'{FUNNEL_PAGE_ORIGIN}/')
    assert wib.startswith(f'{FUNNEL_PAGE_ORIGIN}/')
    assert personal.email == 'wib@example.com'
    assert CODE_PATTERN.search(bodies[0]) is None
    assert CODE_PATTERN.search(pages[0]) is None


def test_email_sends_one_code_per_address_that_redeems_once_for_the_shared_hours(
    client: Client,
    sendgrid_fake: SendgridFake,
) -> None:
    fields_first = {'campaign': 'wib', 'email': ADDRESS}
    fields_again = {'campaign': 'wib', 'email': ' AVERY@example.com'}
    sent_first = _email_request(client, fields_first)

    assert sent_first.status_code == 204

    cache.clear()

    sent_again = _email_request(client, fields_again)

    assert sent_again.status_code == 204

    codes = [_code_in(request) for request in sendgrid_fake.requests]
    token = account_create(client, email='work@example.com', promo_code=codes[0].lower())

    body_reused = {
        'email': 'morgan@example.com',
        'name': 'Morgan',
        'promo_code': codes[0],
        'region': 'CA-AB',
    }

    reused = api_post(client, ACCOUNT_PATH, body=body_reused)
    balance_seconds = account_get(client, token)['balance_seconds']

    assert codes == [codes[0], codes[0]]
    assert PromoCode.objects.issued().count() == 1
    assert balance_seconds == WIB_HOURS * SECONDS_PER_HOUR
    assert reused.status_code == 400
    assert 'fully redeemed' in reused.json()['error']['message']


def test_email_keeps_the_names_on_the_code_and_states_the_hours_the_code_carries(
    client: Client,
    sendgrid_fake: SendgridFake,
    wib_offer: PromoCode,
) -> None:
    wib_offer.services.processor.early_save(early_codes_max=1, early_hours=75)

    fields_early = {
        'campaign': 'wib',
        'email': ADDRESS,
        'name_first': '  Avery ',
        'name_last': 'Lee  ',
    }

    fields_later = {'campaign': 'wib', 'email': 'morgan@example.com'}
    fields_long = {'campaign': 'wib', 'email': 'riley@example.com', 'name_last': 'N' * 201}
    early = _email_request(client, fields_early)
    later = _email_request(client, fields_later)
    refused = _email_request(client, fields_long)

    assert early.status_code == 204
    assert later.status_code == 204
    assert refused.status_code == 400
    assert sendgrid_fake.recipients() == [ADDRESS, 'morgan@example.com']

    codes = [_code_in(request) for request in sendgrid_fake.requests]
    bodies = [_content(request, 'text/plain') for request in sendgrid_fake.requests]
    promos = [PromoCode.objects.get(code=code) for code in codes]
    names = [(promo.name_first, promo.name_last) for promo in promos]

    assert [promo.hours for promo in promos] == [75, WIB_HOURS]
    assert names == [('Avery', 'Lee'), ('', '')]

    for promo, body in zip(promos, bodies, strict=True):
        assert f'It covers {promo.hours} hours of free meeting notes.' in body


def test_email_without_the_shared_offer_is_unavailable_and_the_address_can_retry(
    caplog: pytest.LogCaptureFixture,
    client: Client,
    sendgrid_fake: SendgridFake,
    wib_offer: PromoCode,
) -> None:
    caplog.set_level(logging.ERROR, logger=LOGGER_PROMO)

    fields = {'campaign': 'wib', 'email': ADDRESS}
    wib_offer.services.processor.active_set(is_active=False)
    refused = _email_request(client, fields)
    wib_offer.services.processor.active_set(is_active=True)
    retried = _email_request(client, fields)

    assert refused.status_code == 503
    assert refused.json()['error']['code'] == 'email_unavailable'
    assert refused.json()['error']['message'] == FUNNEL_OFFER_UNSET_MESSAGE
    assert 'has no active shared promo code WIB2026' in caplog.text
    assert retried.status_code == 204
    assert sendgrid_fake.recipients() == [ADDRESS]


def test_email_refuses_a_malformed_address_or_an_undeclared_campaign(
    client: Client,
    sendgrid_fake: SendgridFake,
) -> None:
    address_longest = f'{"a" * 64}@{ADDRESS_DOMAIN_LONGEST}'
    address_over = f'{"a" * 65}@{ADDRESS_DOMAIN_LONGEST}'

    requests = [
        {'campaign': 'wib', 'email': ''},
        {'campaign': 'wib', 'email': 'avery'},
        {'campaign': 'wib', 'email': 'avery@example'},
        {'campaign': 'wib', 'email': f'{ADDRESS}\r\nBcc: victim@example.com'},
        {'campaign': 'wib', 'email': address_over},
        {'campaign': 'spring', 'email': ADDRESS},
        {'campaign': 'wib'},
        {'email': ADDRESS},
    ]

    for fields in requests:
        response = _email_request(client, fields)

        assert response.status_code == 400, fields
        assert response.json()['error']['code'] == 'request_invalid', fields

    fields_longest = {'campaign': 'wib', 'email': address_longest}
    response_longest = _email_request(client, fields_longest)

    assert len(address_longest) == 254
    assert len(address_over) == 255
    assert response_longest.status_code == 204
    assert sendgrid_fake.recipients() == [address_longest]
    assert PromoCode.objects.issued().get().email == address_longest


@pytest.mark.parametrize('kind', SENDGRID_ERROR_KINDS)
def test_email_sendgrid_does_not_confirm_is_unavailable_and_the_address_can_retry(
    caplog: pytest.LogCaptureFixture,
    client: Client,
    kind: str,
    sendgrid_fake: SendgridFake,
) -> None:
    assert kind in SENDGRID_ERROR_KINDS

    caplog.set_level(logging.ERROR, logger=LOGGER_MAIL)

    fields = {'campaign': 'wib', 'email': ADDRESS}
    sendgrid_fake.error = _sendgrid_error(kind)
    failed = _email_request(client, fields)
    sendgrid_fake.error = None
    retried = _email_request(client, fields)
    bodies = [_content(request, 'text/plain') for request in sendgrid_fake.requests]

    assert bodies[0] == bodies[1]
    assert failed.status_code == 503
    assert failed.json()['error']['code'] == 'email_unavailable'
    assert 'SendGrid did not confirm the wib email' in caplog.text
    assert retried.status_code == 204
    assert sendgrid_fake.recipients() == [ADDRESS, ADDRESS]
    assert PromoCode.objects.issued().count() == 1


def test_email_rate_counts_apart_from_beacons_and_stops_at_its_own_limit(
    client: Client,
    sendgrid_fake: SendgridFake,
) -> None:
    rate_email = int(THROTTLE_RATE_EMAIL.split('/')[0])
    fields_visit = {'campaign': 'wib', 'source': 'qr'}
    body_visit = urlencode(fields_visit)

    for index in range(rate_email + 1):
        response = client.post(FUNNEL_VISIT_PATH, data=body_visit, content_type=BEACON_CONTENT_TYPE)

        assert response.status_code == 204, index

    for index in range(rate_email):
        fields = {'campaign': 'wib', 'email': f'person{index}@example.com'}
        response = _email_request(client, fields)

        assert response.status_code == 204, index

    fields_over = {'campaign': 'wib', 'email': 'over@example.com'}
    throttled = _email_request(client, fields_over)

    assert throttled.status_code == 429
    assert throttled.json()['error']['code'] == 'throttled'
    assert throttled['Access-Control-Allow-Origin'] == FUNNEL_PAGE_ORIGIN
    assert len(sendgrid_fake.requests) == rate_email
    assert PromoCode.objects.issued().count() == rate_email


def test_email_stops_at_the_daily_maximum_and_resumes_the_next_day(
    client: Client,
    monkeypatch: pytest.MonkeyPatch,
    sendgrid_fake: SendgridFake,
) -> None:
    monkeypatch.setattr(mail, 'FUNNEL_EMAIL_DAY_COUNT_MAX', 2)

    for address in ('first@example.com', 'second@example.com'):
        fields = {'campaign': 'wib', 'email': address}
        response = _email_request(client, fields)

        assert response.status_code == 204, address

    fields_third = {'campaign': 'wib', 'email': 'third@example.com'}
    refused = _email_request(client, fields_third)
    tomorrow = timezone.localdate() + timedelta(days=1)

    monkeypatch.setattr(timezone, 'localdate', lambda: tomorrow)

    resumed = _email_request(client, fields_third)
    recipients = ['first@example.com', 'second@example.com', 'third@example.com']

    assert refused.status_code == 503
    assert refused.json()['error']['code'] == 'email_unavailable'
    assert resumed.status_code == 204
    assert sendgrid_fake.recipients() == recipients


def test_email_to_an_address_already_sent_this_hour_sends_nothing_more(
    client: Client,
    sendgrid_fake: SendgridFake,
) -> None:
    for address in (ADDRESS, ' AVERY@example.com', 'morgan@example.com', ADDRESS):
        fields = {'campaign': 'wib', 'email': address}
        response = _email_request(client, fields)

        assert response.status_code == 204, address

    assert sendgrid_fake.recipients() == [ADDRESS, 'morgan@example.com']
    assert PromoCode.objects.issued().count() == 2


def test_email_without_a_sendgrid_key_is_unavailable_and_sends_nothing(
    client: Client,
    sendgrid_fake: SendgridFake,
    settings: Settings,
) -> None:
    settings.SENDGRID_API_KEY = ''

    fields = {'campaign': 'wib', 'email': ADDRESS}
    response = _email_request(client, fields)

    assert response.status_code == 503
    assert response.json()['error']['code'] == 'email_unavailable'
    assert sendgrid_fake.requests == []
    assert not PromoCode.objects.issued().exists()


def test_funnel_answers_carry_the_landing_page_origin_and_other_answers_do_not(
    client: Client,
    sendgrid_fake: SendgridFake,
) -> None:
    fields_sent = {'campaign': 'wib', 'email': ADDRESS}
    fields_invalid = {'campaign': 'wib', 'email': 'avery'}
    fields_failed = {'campaign': 'wib', 'email': 'morgan@example.com'}
    fields_visit = {'campaign': 'wib', 'source': 'qr'}
    body_visit = urlencode(fields_visit)
    body_account = {'email': ADDRESS, 'name': 'Avery', 'promo_code': '', 'region': 'CA-AB'}

    sent = _email_request(client, fields_sent)
    invalid = _email_request(client, fields_invalid)
    sendgrid_fake.error = _sendgrid_error('unreachable')
    failed = _email_request(client, fields_failed)
    visit = client.post(FUNNEL_VISIT_PATH, data=body_visit, content_type=BEACON_CONTENT_TYPE)
    account = api_post(client, ACCOUNT_PATH, body=body_account)
    answers = [sent, invalid, failed, visit]

    assert [answer.status_code for answer in answers] == [204, 400, 503, 204]
    assert {answer['Access-Control-Allow-Origin'] for answer in answers} == {FUNNEL_PAGE_ORIGIN}
    assert account.status_code == 201
    assert 'Access-Control-Allow-Origin' not in account
