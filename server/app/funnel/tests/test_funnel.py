from __future__ import annotations

import random

import pytest
import stripe

from collections import Counter
from decimal import Decimal
from fractions import Fraction
from types import MappingProxyType
from typing_extensions import TYPE_CHECKING, cast
from urllib.parse import urlencode

from django.core.cache import cache
from django.db import transaction
from django.test import Client

from django_spire.metric import metric as spire_metric

from app.account.constants import CHARGE_SECONDS_MAX, SECONDS_PER_HOUR, SIGNED_OUT_MESSAGE
from app.account.ledger.models import AccountLedgerEntry
from app.account.tests.factories import create_test_account
from app.api.v1.account.router import ACTION_UNKNOWN_MESSAGE
from app.funnel.choices import CampaignChoices, FunnelPageChoices, FunnelPlatformChoices
from app.funnel.metric import (
    METRIC_HOURS_QUANTUM,
    MetricAction,
    MetricStatistic,
    RemiMetric,
    funnel_click_record,
    funnel_download_record,
    funnel_lead_record,
    funnel_page_belongs,
    funnel_redemption_record,
    funnel_signup_record,
    metric_action_record,
    metric_hours,
    metric_record,
)
from app.promo_code.models import PromoCode
from app.promo_code.tests.factories import create_test_promo_code
from harness.api import (
    ACCOUNT_ACTION_PATH,
    ACCOUNT_CHECKOUT_PATH,
    ACCOUNT_PROMO_PATH,
    BEACON_CONTENT_TYPE,
    FUNNEL_CLICK_PATH,
    FUNNEL_DOWNLOAD_PATH,
    FUNNEL_EMAIL_PATH,
    account_create,
    api_post,
    checkout_finish,
    checkout_start,
)
from harness.fixtures import PRICE_HOURS
from harness.metric import MetricDispatch, MetricExecutorFake

if TYPE_CHECKING:
    from django.test.client import _MonkeyPatchedWSGIResponse

    from pytest_django.fixtures import DjangoCaptureOnCommitCallbacks

    from harness.stripe import StripeFake


pytestmark = pytest.mark.django_db
DOWNLOAD_SAMPLES = 200
JOB_ID = '86dfb1d3b0140ecf2fd59075421f1cb5'
JOB_ID_SECOND = '4c1f0e8a9b2d7e6f5a4b3c2d1e0f9a8b'
JOB_ID_THIRD = 'a7e3c9d1f5b2084e6a1c3d5f7b9e0d2c'
METRIC_HOURS_SAMPLES = 200
REFERENCE_DOWNLOAD = 'remi:acquisition:click:download'
REFERENCE_DOWNLOAD_LINUX = 'remi:acquisition:click:download:linux'
REFERENCE_DOWNLOAD_MAC = 'remi:acquisition:click:download:mac'
REFERENCE_DOWNLOAD_WIB = 'remi:acquisition:click:wib:download'
REFERENCE_DOWNLOAD_WINDOWS = 'remi:acquisition:click:download:windows'
REFERENCE_HOURS = 'remi:action:hours-transcribed'
REFERENCE_LANDING = 'remi:acquisition:click:landing'
REFERENCE_LEAD = 'remi:acquisition:lead:promo-code'
REFERENCE_LEAD_WIB = 'remi:acquisition:lead:wib:promo-code'
REFERENCE_MEETING = 'remi:action:meeting-transcribed'
REFERENCE_PROMO_WIB = 'remi:acquisition:click:wib:promo'
REFERENCE_PURCHASE = 'remi:action:purchase-hours'
REFERENCE_REDEMPTION = 'remi:acquisition:redemption:promo-code'
REFERENCE_REDEMPTION_WIB = 'remi:acquisition:redemption:wib:promo-code'
REFERENCE_SIGNUP = 'remi:acquisition:signup:completed'
REFERENCE_SIGNUP_WIB = 'remi:acquisition:signup:wib:promo-code'
STATISTIC_ACQUISITION = 'remi--remi-metric--acquisition'
STATISTIC_ACTION = 'remi--remi-metric--action'
SUB_DOMAIN_METRICS = 'remi--metrics'
VALUE_ONE = Decimal(1)

ACTION_BODIES_INVALID = (
    {},
    {'action': 7},
    {'action': None},
    ['new-chat'],
)

ACTIONS_APP = (
    'ask-folder-question',
    'ask-library-question',
    'ask-note-question',
    'change-theme',
    'in-app-recording',
    'new-chat',
    'new-folder-created',
    'new-template',
    'upload-recording',
)

ACTIONS_REFUSED = (
    'hours-transcribed',
    'meeting-transcribed',
    'purchase-hours',
    'new-meeting',
    'NEW-CHAT',
    ' new-chat',
    '',
)

EMAIL_REQUESTS = (
    ('wib', 'avery@example.com'),
    ('wib', ' AVERY@example.com'),
    ('general', 'casey@example.com'),
    ('wib', 'morgan@example.com'),
    ('wib', 'avery@example.com'),
)

PROMO_REDEMPTIONS = (
    ('WELCOME', 200),
    ('WIB2026', 200),
    ('WIB2026', 400),
    ('SPENT', 400),
    ('NOPE', 400),
)

ERROR_ACTION_UNKNOWN = MappingProxyType({
    'code': 'request_invalid',
    'message': ACTION_UNKNOWN_MESSAGE,
    'type': 'billing_error',
})

ERROR_TOKEN_INVALID = MappingProxyType({
    'code': 'token_invalid',
    'message': SIGNED_OUT_MESSAGE,
    'type': 'billing_error',
})

REFERENCES_ACQUISITION = frozenset({
    'remi:acquisition:click:download',
    'remi:acquisition:click:download:linux',
    'remi:acquisition:click:download:mac',
    'remi:acquisition:click:download:windows',
    'remi:acquisition:click:landing',
    'remi:acquisition:click:wib:download',
    'remi:acquisition:click:wib:promo',
    'remi:acquisition:lead:promo-code',
    'remi:acquisition:lead:wib:promo-code',
    'remi:acquisition:redemption:promo-code',
    'remi:acquisition:redemption:wib:promo-code',
    'remi:acquisition:signup:completed',
    'remi:acquisition:signup:wib:promo-code',
})

REFERENCES_DOWNLOAD_PLATFORM = (
    REFERENCE_DOWNLOAD_LINUX,
    REFERENCE_DOWNLOAD_MAC,
    REFERENCE_DOWNLOAD_WINDOWS,
)

REFERENCES_ACTION = frozenset({
    'remi:action:ask-folder-question',
    'remi:action:ask-library-question',
    'remi:action:ask-note-question',
    'remi:action:change-theme',
    'remi:action:hours-transcribed',
    'remi:action:in-app-recording',
    'remi:action:meeting-transcribed',
    'remi:action:new-chat',
    'remi:action:new-folder-created',
    'remi:action:new-template',
    'remi:action:purchase-hours',
    'remi:action:upload-recording',
})


def _acquisition(reference: str) -> MetricDispatch:
    assert reference in REFERENCES_ACQUISITION
    assert reference not in REFERENCES_ACTION

    return MetricDispatch(reference, STATISTIC_ACQUISITION, SUB_DOMAIN_METRICS, VALUE_ONE)


def _action(reference: str, value: Decimal = VALUE_ONE) -> MetricDispatch:
    assert reference in REFERENCES_ACTION
    assert value > 0

    return MetricDispatch(reference, STATISTIC_ACTION, SUB_DOMAIN_METRICS, value)


def _action_send(client: Client, *, action: str, token: str) -> _MonkeyPatchedWSGIResponse:
    assert len(action) <= 64
    assert token == token.strip()

    body = {'action': action}

    return api_post(client, ACCOUNT_ACTION_PATH, body=body, token=token)


def _beacon_send(
    client: Client,
    path: str,
    fields: dict[str, str],
) -> _MonkeyPatchedWSGIResponse:
    assert path in (FUNNEL_CLICK_PATH, FUNNEL_DOWNLOAD_PATH)
    assert fields.keys() <= {'campaign', 'code', 'page', 'platform'}

    return client.post(path, data=urlencode(fields), content_type=BEACON_CONTENT_TYPE)


def _email_send(client: Client, *, address: str, campaign: str) -> _MonkeyPatchedWSGIResponse:
    assert campaign in CampaignChoices.values
    assert address.strip() != ''

    fields = {'campaign': campaign, 'email': address}

    return client.post(FUNNEL_EMAIL_PATH, data=urlencode(fields), content_type=BEACON_CONTENT_TYPE)


def _metric_record_rolled_back() -> None:
    with transaction.atomic():
        metric_action_record(MetricAction.CHAT_NEW)

        message = 'the chat is rolled back'
        raise RuntimeError(message)


def test_action_endpoint_counts_each_app_action_with_no_account_in_it(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        token = account_create(client)

        for action in ACTIONS_APP:
            response = _action_send(client, action=action, token=token)

            assert response.status_code == 204, action
            assert response.content == b'', action

    actions = [_action(f'remi:action:{action}') for action in ACTIONS_APP]

    assert metric_dispatched.dispatched == [_acquisition(REFERENCE_SIGNUP), *actions]


def test_action_endpoint_refuses_a_server_action_an_unknown_action_or_a_bad_body(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        token = account_create(client)

        for action in ACTIONS_REFUSED:
            response = _action_send(client, action=action, token=token)

            assert response.status_code == 400, action
            assert response.json() == {'error': ERROR_ACTION_UNKNOWN}, action

        for body in ACTION_BODIES_INVALID:
            response = api_post(client, ACCOUNT_ACTION_PATH, body=body, token=token)

            assert response.status_code == 400, body
            assert response.json()['error']['code'] == 'request_invalid', body

    assert metric_dispatched.dispatched == [_acquisition(REFERENCE_SIGNUP)]


def test_action_endpoint_refuses_a_request_without_a_valid_token(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        for token in ('', 'wrong'):
            response = _action_send(client, action='new-chat', token=token)

            assert response.status_code == 401, token
            assert response.json() == {'error': ERROR_TOKEN_INVALID}, token

    assert metric_dispatched.dispatched == []


def test_beacons_need_no_csrf_token_or_sign_in(
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        client = Client(enforce_csrf_checks=True)
        fields = {'campaign': 'wib', 'page': 'promo'}
        response = _beacon_send(client, FUNNEL_CLICK_PATH, fields)

    assert response.status_code == 204
    assert metric_dispatched.dispatched == [_acquisition(REFERENCE_PROMO_WIB)]


def test_beacons_refuse_an_undeclared_campaign_page_or_platform(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        beacons = [
            (FUNNEL_CLICK_PATH, {'campaign': 'spring', 'page': 'promo'}),
            (FUNNEL_CLICK_PATH, {'campaign': 'wib', 'page': 'download'}),
            (FUNNEL_CLICK_PATH, {'campaign': 'wib'}),
            (FUNNEL_CLICK_PATH, {'campaign': 'general', 'page': 'promo'}),
            (FUNNEL_CLICK_PATH, {'campaign': 'wib', 'page': 'landing'}),
            (FUNNEL_DOWNLOAD_PATH, {'campaign': 'wib', 'platform': 'solaris'}),
            (FUNNEL_DOWNLOAD_PATH, {'platform': 'linux'}),
            (FUNNEL_DOWNLOAD_PATH, {'campaign': 'wib', 'code': 'two words', 'platform': 'linux'}),
            (FUNNEL_DOWNLOAD_PATH, {'campaign': 'wib', 'code': 'W' * 65, 'platform': 'linux'}),
        ]

        for path, fields in beacons:
            response = _beacon_send(client, path, fields)

            assert response.status_code == 400, fields
            assert response.json()['error']['code'] == 'request_invalid', fields

    assert metric_dispatched.dispatched == []


def test_charge_records_a_meeting_and_its_hours_once_per_job(
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    account = create_test_account(seconds=SECONDS_PER_HOUR)

    with django_capture_on_commit_callbacks(execute=True):
        account.services.processor.charge(job_id=JOB_ID, seconds=1800)
        account.services.processor.charge(job_id=JOB_ID, seconds=1800)

    assert account.ledger_entries.charges().count() == 1

    assert metric_dispatched.dispatched == [
        _action(REFERENCE_MEETING),
        _action(REFERENCE_HOURS, Decimal('0.5000')),
    ]


def test_charges_count_every_meeting_of_every_account_alike(
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        first = create_test_account(seconds=SECONDS_PER_HOUR)
        second = create_test_account(email='morgan@example.com', seconds=SECONDS_PER_HOUR)

        first.services.processor.charge(job_id=JOB_ID, seconds=600)
        first.services.processor.charge(job_id=JOB_ID_SECOND, seconds=600)
        second.services.processor.charge(job_id=JOB_ID_THIRD, seconds=600)

    signups = [_acquisition(REFERENCE_SIGNUP)] * 2
    meeting = [_action(REFERENCE_MEETING), _action(REFERENCE_HOURS, Decimal('0.1667'))]

    assert metric_dispatched.dispatched == signups + meeting * 3


def test_checkout_records_nothing_until_its_purchase_succeeds(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    stripe_fake: StripeFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        token = account_create(client)

        checkout_start(client, hours=PRICE_HOURS, token=token)
        checkout_start(client, hours=PRICE_HOURS, token=token)

        stripe_fake.create_error = stripe.APIConnectionError('connection reset')
        body = {'hours': PRICE_HOURS}
        refused = api_post(client, ACCOUNT_CHECKOUT_PATH, body=body, token=token)

    assert refused.status_code == 503
    assert len(stripe_fake.created) == 2
    assert metric_dispatched.dispatched == [_acquisition(REFERENCE_SIGNUP)]


def test_click_beacon_counts_a_landing_click_and_a_campaign_promo_arrival(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        fields_landing = {'campaign': 'general', 'page': 'landing'}
        fields_promo = {'campaign': 'wib', 'page': 'promo'}
        landing = _beacon_send(client, FUNNEL_CLICK_PATH, fields_landing)
        promo = _beacon_send(client, FUNNEL_CLICK_PATH, fields_promo)

    assert landing.status_code == 204
    assert promo.status_code == 204

    assert metric_dispatched.dispatched == [
        _acquisition(REFERENCE_LANDING),
        _acquisition(REFERENCE_PROMO_WIB),
    ]


def test_download_beacon_counts_the_total_and_the_platform_of_each_installer(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        for platform in ('linux', 'macos', 'windows'):
            fields = {'campaign': 'general', 'platform': platform}
            response = _beacon_send(client, FUNNEL_DOWNLOAD_PATH, fields)

            assert response.status_code == 204, platform

    assert metric_dispatched.dispatched == [
        _acquisition(REFERENCE_DOWNLOAD),
        _acquisition(REFERENCE_DOWNLOAD_LINUX),
        _acquisition(REFERENCE_DOWNLOAD),
        _acquisition(REFERENCE_DOWNLOAD_MAC),
        _acquisition(REFERENCE_DOWNLOAD),
        _acquisition(REFERENCE_DOWNLOAD_WINDOWS),
    ]


def test_download_beacon_on_a_campaign_page_also_counts_the_campaign_download(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        fields = {'campaign': 'wib', 'platform': 'windows'}
        response = _beacon_send(client, FUNNEL_DOWNLOAD_PATH, fields)

    assert response.status_code == 204

    assert metric_dispatched.dispatched == [
        _acquisition(REFERENCE_DOWNLOAD),
        _acquisition(REFERENCE_DOWNLOAD_WINDOWS),
        _acquisition(REFERENCE_DOWNLOAD_WIB),
    ]


def test_download_beacon_with_a_personal_code_stamps_its_first_download_only(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    shared = create_test_promo_code(campaign=CampaignChoices.WIB, code='WIB2026', hours=50)
    personal = shared.services.processor.issue('avery@example.com')

    with django_capture_on_commit_callbacks(execute=True):
        fields = {'campaign': 'wib', 'code': f' {personal.code.lower()} ', 'platform': 'macos'}
        fields_shared = {'campaign': 'wib', 'code': 'WIB2026', 'platform': 'windows'}
        fields_unknown = {'campaign': 'wib', 'code': 'WIB-2222-2222', 'platform': 'linux'}
        first = _beacon_send(client, FUNNEL_DOWNLOAD_PATH, fields)
        stamped = PromoCode.objects.get(pk=personal.pk).downloaded_datetime
        again = _beacon_send(client, FUNNEL_DOWNLOAD_PATH, fields)
        unknown = _beacon_send(client, FUNNEL_DOWNLOAD_PATH, fields_unknown)
        common = _beacon_send(client, FUNNEL_DOWNLOAD_PATH, fields_shared)

    answers = [first, again, unknown, common]

    assert [answer.status_code for answer in answers] == [204, 204, 204, 204]
    assert stamped is not None
    assert PromoCode.objects.get(pk=personal.pk).downloaded_datetime == stamped
    assert PromoCode.objects.get(pk=shared.pk).downloaded_datetime is None

    assert Counter(metric_dispatched.references()) == {
        REFERENCE_DOWNLOAD: 4,
        REFERENCE_DOWNLOAD_LINUX: 1,
        REFERENCE_DOWNLOAD_MAC: 2,
        REFERENCE_DOWNLOAD_WIB: 4,
        REFERENCE_DOWNLOAD_WINDOWS: 1,
    }


def test_download_total_equals_the_sum_of_its_platforms_for_any_beacon_sequence(
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    generator = random.Random(2026)
    campaigns = sorted(CampaignChoices.values)
    platforms = sorted(FunnelPlatformChoices.values)

    beacons = [
        (generator.choice(campaigns), generator.choice(platforms))
        for _ in range(DOWNLOAD_SAMPLES)
    ]

    with django_capture_on_commit_callbacks(execute=True):
        for campaign, platform in beacons:
            funnel_download_record(campaign=campaign, platform=platform)

    counts = Counter(metric_dispatched.references())
    counts_platform = Counter(platform for _, platform in beacons)

    assert counts[REFERENCE_DOWNLOAD] == DOWNLOAD_SAMPLES
    assert counts[REFERENCE_DOWNLOAD_LINUX] == counts_platform['linux']
    assert counts[REFERENCE_DOWNLOAD_MAC] == counts_platform['macos']
    assert counts[REFERENCE_DOWNLOAD_WINDOWS] == counts_platform['windows']

    platforms_count = sum(counts[reference] for reference in REFERENCES_DOWNLOAD_PLATFORM)
    wib_count = sum(1 for campaign, _ in beacons if campaign == 'wib')

    assert counts[REFERENCE_DOWNLOAD] == platforms_count
    assert counts[REFERENCE_DOWNLOAD_WIB] == wib_count
    assert counts.total() == 2 * DOWNLOAD_SAMPLES + wib_count
    assert 0 < wib_count < DOWNLOAD_SAMPLES


@pytest.mark.usefixtures('sendgrid_fake')
def test_email_counts_a_lead_for_each_personal_code_it_issues_and_none_without_one(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    create_test_promo_code(campaign=CampaignChoices.WIB, code='WIB2026')

    with django_capture_on_commit_callbacks(execute=True):
        for campaign, address in EMAIL_REQUESTS:
            cache.clear()

            response = _email_send(client, address=address, campaign=campaign)

            assert response.status_code == 204, address

    issued_count = PromoCode.objects.issued().count()
    leads = [_acquisition(REFERENCE_LEAD), _acquisition(REFERENCE_LEAD_WIB)]

    assert issued_count == 2
    assert metric_dispatched.dispatched == leads * issued_count


def test_funnel_records_refuse_an_undeclared_campaign_page_or_platform(
    metric_dispatched: MetricExecutorFake,
) -> None:
    with pytest.raises(ValueError, match='campaign must be one of'):
        funnel_download_record(campaign='spring', platform='linux')

    with pytest.raises(ValueError, match='platform must be one of'):
        funnel_download_record(campaign='wib', platform='solaris')

    with pytest.raises(ValueError, match='campaign must be one of'):
        funnel_click_record(campaign='spring', page='promo')

    with pytest.raises(ValueError, match='page must be one of'):
        funnel_click_record(campaign='wib', page='download')

    with pytest.raises(ValueError, match='the general campaign has no promo page'):
        funnel_click_record(campaign='general', page='promo')

    with pytest.raises(ValueError, match='the wib campaign has no landing page'):
        funnel_click_record(campaign='wib', page='landing')

    with pytest.raises(ValueError, match='campaign must be one of'):
        funnel_lead_record(campaign='spring')

    with pytest.raises(ValueError, match='campaign must be one of'):
        funnel_redemption_record(campaign='spring')

    with pytest.raises(ValueError, match='campaign must be one of'):
        funnel_signup_record(campaign='spring')

    assert metric_dispatched.dispatched == []


def test_metric_hours_stays_within_half_a_quantum_of_the_exact_hours() -> None:
    generator = random.Random(2026)
    samples_random = [generator.randint(1, CHARGE_SECONDS_MAX) for _ in range(METRIC_HOURS_SAMPLES)]
    samples = [1, 2, 18, 3599, 3600, 5400, CHARGE_SECONDS_MAX, *samples_random]
    tolerance = Fraction(METRIC_HOURS_QUANTUM) / 2

    for seconds in samples:
        hours = metric_hours(seconds)
        exact = Fraction(seconds, SECONDS_PER_HOUR)

        assert abs(Fraction(hours) - exact) <= tolerance, seconds
        assert hours == hours.quantize(METRIC_HOURS_QUANTUM), seconds
        assert hours > 0, seconds

    assert metric_hours(1) == Decimal('0.0003')
    assert metric_hours(18) == Decimal('0.0050')

    for seconds in (0, -1):
        with pytest.raises(ValueError, match='must be positive'):
            metric_hours(seconds)


def test_metric_record_refuses_an_undeclared_statistic_segment_or_value(
    metric_dispatched: MetricExecutorFake,
) -> None:
    segments_malformed = ('', 'New-Chat', 'new chat', 'new--chat', '-new', 'new-', 'new:chat')

    with pytest.raises(TypeError, match='statistic must be a MetricStatistic'):
        metric_record(cast('MetricStatistic', 'action'), 'new-chat')

    with pytest.raises(TypeError, match='action must be a MetricAction'):
        metric_action_record(cast('MetricAction', 'new-chat'))

    for segments in ((), ('a', 'b', 'c', 'd')):
        with pytest.raises(ValueError, match='a reference carries 1 to 3 segments'):
            metric_record(MetricStatistic.ACTION, *segments)

    for segment in segments_malformed:
        with pytest.raises(ValueError, match='a reference segment is lowercase words'):
            metric_record(MetricStatistic.ACTION, segment)

    with pytest.raises(ValueError, match='a reference is at most 64 characters'):
        metric_record(MetricStatistic.ACTION, 'a' * 26, 'b' * 26)

    for value in (Decimal(0), Decimal(-1)):
        with pytest.raises(ValueError, match='value must be positive'):
            metric_record(MetricStatistic.ACTION, 'new-chat', value=value)

    assert metric_dispatched.dispatched == []


def test_metric_record_rolled_back_with_its_transaction_sends_nothing(
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    capture = django_capture_on_commit_callbacks(execute=True)

    with capture as callbacks, pytest.raises(RuntimeError, match='rolled back'):
        _metric_record_rolled_back()

    assert callbacks == []
    assert metric_dispatched.dispatched == []


def test_metric_record_without_a_remote_target_sends_nothing(
    monkeypatch: pytest.MonkeyPatch,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    executor = MetricExecutorFake()

    monkeypatch.setattr(spire_metric, '_record_executor', executor)

    with django_capture_on_commit_callbacks(execute=True) as callbacks:
        metric_action_record(MetricAction.CHAT_NEW)

    assert callbacks == []
    assert executor.dispatched == []


def test_metric_registry_declares_the_keys_the_portal_holds() -> None:
    keys = RemiMetric.stored_keys()

    assert keys['domains'] == {'remi'}
    assert keys['subdomains'] == {'remi--metrics'}
    assert keys['statistic_groups'] == {'remi--remi-metric'}
    assert keys['statistics'] == {'remi--remi-metric--acquisition', 'remi--remi-metric--action'}


@pytest.mark.usefixtures('stripe_configured')
def test_promo_redemptions_count_once_each_at_sign_up_or_after_and_refusals_count_none(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    create_test_promo_code(campaign=CampaignChoices.WIB, code='WIB2026')
    create_test_promo_code(code='SPENT', redemptions_max=0)
    create_test_promo_code(code='WELCOME')

    with django_capture_on_commit_callbacks(execute=True):
        account_create(client, promo_code='WIB2026')
        token = account_create(client, email='morgan@example.com')

        for code, status in PROMO_REDEMPTIONS:
            body = {'code': code}
            response = api_post(client, ACCOUNT_PROMO_PATH, body=body, token=token)

            assert response.status_code == status, code

    promos = AccountLedgerEntry.objects.promos()

    assert promos.count() == 3

    assert Counter(metric_dispatched.references()) == {
        REFERENCE_REDEMPTION: promos.count(),
        REFERENCE_REDEMPTION_WIB: promos.by_campaign(CampaignChoices.WIB).count(),
        REFERENCE_SIGNUP: 2,
        REFERENCE_SIGNUP_WIB: 1,
    }


def test_purchase_records_purchase_hours_once(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    stripe_fake: StripeFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        token = account_create(client)
        session_id = checkout_start(client, hours=PRICE_HOURS, token=token)
        stripe_fake.pay(session_id)
        finished = checkout_finish(client, session_id=session_id, token=token)
        again = checkout_finish(client, session_id=session_id, token=token)

    assert finished.status_code == 200
    assert again.status_code == 200
    assert AccountLedgerEntry.objects.purchases().count() == 1

    assert metric_dispatched.dispatched == [
        _acquisition(REFERENCE_SIGNUP),
        _action(REFERENCE_PURCHASE),
    ]


def test_purchase_with_a_negative_amount_is_refused_and_credits_nothing(
    metric_dispatched: MetricExecutorFake,
    stripe_fake: StripeFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    account = create_test_account()
    metadata = {'account_id': str(account.pk), 'app': 'remi', 'seconds': str(SECONDS_PER_HOUR)}

    stripe_fake.session_add(
        amount_total=-1,
        metadata=metadata,
        payment_status='paid',
        session_id='cs_test_negative',
    )

    with (
        django_capture_on_commit_callbacks(execute=True),
        pytest.raises(ValueError, match='amount_cents must not be negative'),
    ):
        AccountLedgerEntry.services.factory.purchase_from_session('cs_test_negative')

    assert account.ledger_entries.balance_seconds() == 0
    assert not account.ledger_entries.purchases().exists()
    assert metric_dispatched.dispatched == []


@pytest.mark.parametrize('amount_total', [0, None])
def test_purchase_with_no_charge_or_no_amount_credits_the_hours_and_counts_once(
    amount_total: int | None,
    metric_dispatched: MetricExecutorFake,
    stripe_fake: StripeFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    assert amount_total is None or amount_total >= 0

    account = create_test_account()
    metadata = {'account_id': str(account.pk), 'app': 'remi', 'seconds': str(SECONDS_PER_HOUR)}

    stripe_fake.session_add(
        amount_total=amount_total,
        metadata=metadata,
        payment_status='paid',
        session_id='cs_test_free',
    )

    with django_capture_on_commit_callbacks(execute=True):
        AccountLedgerEntry.services.factory.purchase_from_session('cs_test_free')

    assert account.ledger_entries.balance_seconds() == SECONDS_PER_HOUR
    assert metric_dispatched.dispatched == [_action(REFERENCE_PURCHASE)]


def test_purchases_count_each_paid_session_once(
    metric_dispatched: MetricExecutorFake,
    stripe_fake: StripeFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    account = create_test_account()
    metadata = {'account_id': str(account.pk), 'app': 'remi', 'seconds': str(SECONDS_PER_HOUR)}

    for session_id in ('cs_test_first', 'cs_test_second'):
        stripe_fake.session_add(
            metadata=metadata,
            payment_status='paid',
            session_id=session_id,
        )

    with django_capture_on_commit_callbacks(execute=True):
        for session_id in ('cs_test_first', 'cs_test_first', 'cs_test_second'):
            AccountLedgerEntry.services.factory.purchase_from_session(session_id)

    assert account.ledger_entries.purchases().count() == 2
    assert metric_dispatched.dispatched == [_action(REFERENCE_PURCHASE)] * 2


def test_recorders_produce_exactly_the_closed_reference_set(
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        for campaign in CampaignChoices.values:
            funnel_lead_record(campaign=campaign)
            funnel_redemption_record(campaign=campaign)
            funnel_signup_record(campaign=campaign)

            for page in FunnelPageChoices.values:
                if funnel_page_belongs(campaign=campaign, page=page):
                    funnel_click_record(campaign=campaign, page=page)

            for platform in FunnelPlatformChoices.values:
                funnel_download_record(campaign=campaign, platform=platform)

        for action in MetricAction:
            metric_action_record(action)

    dispatched = metric_dispatched.dispatched

    acquisition = {
        dispatch.reference
        for dispatch in dispatched
        if dispatch.statistic_key == STATISTIC_ACQUISITION
    }

    action = {
        dispatch.reference
        for dispatch in dispatched
        if dispatch.statistic_key == STATISTIC_ACTION
    }

    assert acquisition == REFERENCES_ACQUISITION
    assert action == REFERENCES_ACTION
    assert len(acquisition) + len(action) == len(set(metric_dispatched.references()))
    assert {dispatch.sub_domain_key for dispatch in dispatched} == {SUB_DOMAIN_METRICS}
    assert {dispatch.value for dispatch in dispatched} == {VALUE_ONE}


def test_signup_counts_every_account_and_a_campaign_promo_under_its_campaign(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    create_test_promo_code(campaign=CampaignChoices.WIB, code='WIB2026')
    create_test_promo_code(code='WELCOME')

    with django_capture_on_commit_callbacks(execute=True):
        account_create(client, promo_code='WIB2026')
        account_create(client, email='morgan@example.com')
        account_create(client, email='riley@example.com', promo_code='WELCOME')

    assert AccountLedgerEntry.objects.promos().count() == 2

    assert metric_dispatched.dispatched == [
        _acquisition(REFERENCE_REDEMPTION),
        _acquisition(REFERENCE_REDEMPTION_WIB),
        _acquisition(REFERENCE_SIGNUP),
        _acquisition(REFERENCE_SIGNUP_WIB),
        _acquisition(REFERENCE_SIGNUP),
        _acquisition(REFERENCE_REDEMPTION),
        _acquisition(REFERENCE_SIGNUP),
    ]
