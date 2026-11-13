from __future__ import annotations

import logging
import random

import pytest
import stripe

from decimal import Decimal
from fractions import Fraction
from typing_extensions import TYPE_CHECKING, cast
from urllib.parse import urlencode

from django.db import transaction
from django.test import Client

from django_spire.metric import metric as spire_metric

from app.account.constants import CHARGE_SECONDS_MAX, SECONDS_PER_HOUR
from app.account.ledger.models import AccountLedgerEntry
from app.account.models import Account
from app.account.tests.factories import create_test_account
from app.funnel.choices import CampaignChoices
from app.funnel.metric import (
    METRIC_HOURS_QUANTUM,
    METRIC_REVENUE_CENTS_MAX,
    FunnelStatistic,
    RemiMetric,
    funnel_download_record,
    funnel_visit_record,
    metric_hours,
    metric_record,
    metric_revenue,
)
from app.promo_code.tests.factories import create_test_promo_code
from harness.api import (
    ACCOUNT_CHECKOUT_PATH,
    BEACON_CONTENT_TYPE,
    FUNNEL_DOWNLOAD_PATH,
    FUNNEL_VISIT_PATH,
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
JOB_ID = '86dfb1d3b0140ecf2fd59075421f1cb5'
JOB_ID_SECOND = '4c1f0e8a9b2d7e6f5a4b3c2d1e0f9a8b'
JOB_ID_THIRD = 'a7e3c9d1f5b2084e6a1c3d5f7b9e0d2c'
LOGGER_LEDGER = 'app.account.ledger.services.factory_service'
METRIC_HOURS_SAMPLES = 200
METRIC_REVENUE_SAMPLES = 200
STATISTIC_ACTIVATIONS = 'remi--funnel--activations'
STATISTIC_CHECKOUTS = 'remi--funnel--checkouts'
STATISTIC_REVENUE = 'remi--sales--revenue'
SUB_DOMAIN_GENERAL = 'remi--general'
VALUE_ONE = Decimal(1)


def _beacon_send(
    client: Client,
    path: str,
    fields: dict[str, str],
) -> _MonkeyPatchedWSGIResponse:
    return client.post(path, data=urlencode(fields), content_type=BEACON_CONTENT_TYPE)


def _metric_record_rolled_back() -> None:
    with transaction.atomic():
        metric_record(CampaignChoices.GENERAL, FunnelStatistic.VISITS, reference='link')

        message = 'the visit is rolled back'
        raise RuntimeError(message)


def test_beacons_need_no_csrf_token_or_sign_in(
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        client = Client(enforce_csrf_checks=True)
        fields = {'campaign': 'wib', 'source': 'link'}
        response = _beacon_send(client, FUNNEL_VISIT_PATH, fields)

    assert response.status_code == 204
    assert metric_dispatched.statistic_keys() == ['remi--funnel--visits']


def test_beacons_refuse_an_undeclared_campaign_source_or_platform(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        beacons = [
            (FUNNEL_VISIT_PATH, {'campaign': 'spring', 'source': 'qr'}),
            (FUNNEL_VISIT_PATH, {'campaign': 'wib', 'source': 'email'}),
            (FUNNEL_VISIT_PATH, {'campaign': 'wib'}),
            (FUNNEL_DOWNLOAD_PATH, {'campaign': 'wib', 'platform': 'solaris'}),
            (FUNNEL_DOWNLOAD_PATH, {'platform': 'linux'}),
        ]

        for path, fields in beacons:
            response = _beacon_send(client, path, fields)

            assert response.status_code == 400, fields
            assert response.json()['error']['code'] == 'request_invalid', fields

    assert metric_dispatched.dispatched == []


def test_charge_records_a_meeting_and_its_hours(
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    account = create_test_account(seconds=SECONDS_PER_HOUR)

    with django_capture_on_commit_callbacks(execute=True):
        account.services.processor.charge(job_id=JOB_ID, seconds=1800)
        account.services.processor.charge(job_id=JOB_ID, seconds=1800)

    entry = account.ledger_entries.charges().get()
    reference = f'{JOB_ID}:account_ledger.accountledgerentry:{entry.pk}'

    assert metric_dispatched.dispatched == [
        MetricDispatch(reference, 'remi--usage--meetings', 'remi--general', VALUE_ONE),
        MetricDispatch(reference, 'remi--usage--hours', 'remi--general', Decimal('0.5000')),
        MetricDispatch(reference, STATISTIC_ACTIVATIONS, 'remi--general', VALUE_ONE),
    ]


def test_charge_records_an_activation_only_for_the_first_meeting_of_an_account(
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    first = create_test_account(seconds=SECONDS_PER_HOUR)
    second = create_test_account(email='morgan@example.com', seconds=SECONDS_PER_HOUR)

    with django_capture_on_commit_callbacks(execute=True):
        first.services.processor.charge(job_id=JOB_ID, seconds=600)
        first.services.processor.charge(job_id=JOB_ID_SECOND, seconds=600)
        second.services.processor.charge(job_id=JOB_ID_THIRD, seconds=600)

    entry_first = first.ledger_entries.charges().by_reference(JOB_ID).get()
    entry_second = second.ledger_entries.charges().get()
    reference_first = f'{JOB_ID}:account_ledger.accountledgerentry:{entry_first.pk}'
    reference_second = f'{JOB_ID_THIRD}:account_ledger.accountledgerentry:{entry_second.pk}'
    statistic_keys = metric_dispatched.statistic_keys()

    activations = [
        dispatch
        for dispatch in metric_dispatched.dispatched
        if dispatch.statistic_key == STATISTIC_ACTIVATIONS
    ]

    assert activations == [
        MetricDispatch(reference_first, STATISTIC_ACTIVATIONS, SUB_DOMAIN_GENERAL, VALUE_ONE),
        MetricDispatch(reference_second, STATISTIC_ACTIVATIONS, SUB_DOMAIN_GENERAL, VALUE_ONE),
    ]

    assert statistic_keys.count('remi--usage--meetings') == 3
    assert statistic_keys.count(STATISTIC_ACTIVATIONS) == 2


def test_checkout_records_each_session_started_and_none_that_stripe_refused(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    stripe_fake: StripeFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    create_test_promo_code(campaign=CampaignChoices.WIB, code='WIB2026')

    with django_capture_on_commit_callbacks(execute=True):
        token = account_create(client, promo_code='WIB2026')
        checkout_start(client, hours=PRICE_HOURS, token=token)
        checkout_start(client, hours=PRICE_HOURS, token=token)

        stripe_fake.create_error = stripe.APIConnectionError('connection reset')
        body = {'hours': PRICE_HOURS}
        refused = api_post(client, ACCOUNT_CHECKOUT_PATH, body=body, token=token)

    account = Account.objects.get()
    reference = f'checkout:account.account:{account.pk}'
    started = MetricDispatch(reference, STATISTIC_CHECKOUTS, 'remi--wib', VALUE_ONE)

    checkouts = [
        dispatch
        for dispatch in metric_dispatched.dispatched
        if dispatch.statistic_key == STATISTIC_CHECKOUTS
    ]

    assert refused.status_code == 503
    assert checkouts == [started, started]
    assert len(stripe_fake.created) == 2


def test_download_beacon_counts_each_platform_under_its_campaign(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        for platform in ('linux', 'macos', 'windows'):
            fields = {'campaign': 'general', 'platform': platform}

            assert _beacon_send(client, FUNNEL_DOWNLOAD_PATH, fields).status_code == 204

    dispatched = metric_dispatched.dispatched
    references = [dispatch.reference for dispatch in dispatched]
    sub_domains = {dispatch.sub_domain_key for dispatch in dispatched}
    values = {dispatch.value for dispatch in dispatched}

    assert metric_dispatched.statistic_keys() == [
        'remi--funnel--downloads',
        'remi--funnel--downloads',
        'remi--funnel--downloads',
    ]

    assert references == ['linux', 'macos', 'windows']
    assert sub_domains == {SUB_DOMAIN_GENERAL}
    assert values == {VALUE_ONE}


def test_funnel_records_refuse_an_undeclared_campaign_platform_or_source(
    metric_dispatched: MetricExecutorFake,
) -> None:
    with pytest.raises(ValueError, match='campaign must be one of'):
        funnel_download_record(campaign='spring', platform='linux')

    with pytest.raises(ValueError, match='platform must be one of'):
        funnel_download_record(campaign='wib', platform='solaris')

    with pytest.raises(ValueError, match='campaign must be one of'):
        funnel_visit_record(campaign='spring', source='qr')

    with pytest.raises(ValueError, match='source must be one of'):
        funnel_visit_record(campaign='wib', source='email')

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


def test_metric_record_refuses_an_undeclared_campaign_statistic_reference_or_value(
    metric_dispatched: MetricExecutorFake,
) -> None:
    with pytest.raises(ValueError, match='campaign must be one of'):
        metric_record('spring', FunnelStatistic.VISITS, reference='link')

    with pytest.raises(TypeError, match='statistic must be'):
        metric_record(CampaignChoices.GENERAL, cast('FunnelStatistic', 'visits'), reference='link')

    for reference in ('', 'x' * 65):
        with pytest.raises(ValueError, match='reference must be 1 to 64 characters'):
            metric_record(CampaignChoices.GENERAL, FunnelStatistic.VISITS, reference=reference)

    with pytest.raises(ValueError, match='value must be positive'):
        metric_record(
            CampaignChoices.GENERAL,
            FunnelStatistic.VISITS,
            reference='link',
            value=Decimal(0),
        )

    unsaved = Account(email='unsaved@example.com', name='Unsaved')

    assert unsaved.pk is None

    with pytest.raises(ValueError, match='source_model must be saved'):
        metric_record(
            CampaignChoices.GENERAL,
            FunnelStatistic.SIGNUPS,
            reference='signup',
            source_model=unsaved,
        )

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
        metric_record(CampaignChoices.GENERAL, FunnelStatistic.VISITS, reference='link')

    assert callbacks == []
    assert executor.dispatched == []


def test_metric_registry_declares_the_keys_the_portal_holds() -> None:
    keys = RemiMetric.stored_keys()

    assert keys['domains'] == {'remi'}
    assert keys['subdomains'] == {'remi--general', 'remi--wib'}
    assert keys['statistic_groups'] == {'remi--funnel', 'remi--sales', 'remi--usage'}

    assert keys['statistics'] == {
        'remi--funnel--activations',
        'remi--funnel--checkouts',
        'remi--funnel--downloads',
        'remi--funnel--paying-clients',
        'remi--funnel--promos',
        'remi--funnel--purchases',
        'remi--funnel--scans',
        'remi--funnel--signups',
        'remi--funnel--visits',
        'remi--sales--revenue',
        'remi--usage--hours',
        'remi--usage--meetings',
    }


def test_metric_revenue_converts_cents_exactly_within_the_stripe_limit() -> None:
    generator = random.Random(2026)

    samples_random = [
        generator.randint(1, METRIC_REVENUE_CENTS_MAX)
        for _ in range(METRIC_REVENUE_SAMPLES)
    ]

    samples = [1, 99, 100, 300, 1000, 3000, METRIC_REVENUE_CENTS_MAX, *samples_random]

    for cents in samples:
        revenue = metric_revenue(cents)

        assert Fraction(revenue) == Fraction(cents, 100), cents
        assert revenue.as_tuple().exponent == -2, cents

    assert metric_revenue(1) == Decimal('0.01')
    assert metric_revenue(METRIC_REVENUE_CENTS_MAX) == Decimal('999999.99')

    for cents in (0, -1, METRIC_REVENUE_CENTS_MAX + 1):
        with pytest.raises(ValueError, match='cents must be 1 to'):
            metric_revenue(cents)


def test_purchase_records_its_revenue_once_in_dollars(
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

    entry = AccountLedgerEntry.objects.purchases().get()
    reference = f'checkout:account_ledger.accountledgerentry:{entry.pk}'
    expected = MetricDispatch(reference, STATISTIC_REVENUE, SUB_DOMAIN_GENERAL, Decimal('10.00'))

    revenue = [
        dispatch
        for dispatch in metric_dispatched.dispatched
        if dispatch.statistic_key == STATISTIC_REVENUE
    ]

    assert finished.status_code == 200
    assert again.status_code == 200
    assert revenue == [expected]


def test_purchase_that_is_free_credits_the_hours_and_records_no_revenue(
    caplog: pytest.LogCaptureFixture,
    metric_dispatched: MetricExecutorFake,
    stripe_fake: StripeFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    caplog.set_level(logging.WARNING, logger=LOGGER_LEDGER)

    account = create_test_account()
    metadata = {'account_id': str(account.pk), 'seconds': str(SECONDS_PER_HOUR)}

    stripe_fake.session_add(
        amount_total=0,
        metadata=metadata,
        payment_status='paid',
        session_id='cs_test_free',
    )

    with django_capture_on_commit_callbacks(execute=True):
        AccountLedgerEntry.services.factory.purchase_from_session('cs_test_free')

    assert account.ledger_entries.balance_seconds() == SECONDS_PER_HOUR
    assert STATISTIC_REVENUE not in metric_dispatched.statistic_keys()
    assert 'is free, so it records no revenue' in caplog.text

    assert metric_dispatched.statistic_keys() == [
        'remi--funnel--purchases',
        'remi--funnel--paying-clients',
    ]


def test_purchase_with_a_negative_amount_is_refused_and_credits_nothing(
    metric_dispatched: MetricExecutorFake,
    stripe_fake: StripeFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    account = create_test_account()
    metadata = {'account_id': str(account.pk), 'seconds': str(SECONDS_PER_HOUR)}

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
    assert metric_dispatched.statistic_keys() == []


def test_purchase_without_an_amount_credits_the_hours_and_records_no_revenue(
    caplog: pytest.LogCaptureFixture,
    metric_dispatched: MetricExecutorFake,
    stripe_fake: StripeFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    caplog.set_level(logging.WARNING, logger=LOGGER_LEDGER)

    account = create_test_account()
    metadata = {'account_id': str(account.pk), 'seconds': str(SECONDS_PER_HOUR)}

    stripe_fake.session_add(
        metadata=metadata,
        payment_status='paid',
        session_id='cs_test_bare',
    )

    with django_capture_on_commit_callbacks(execute=True):
        AccountLedgerEntry.services.factory.purchase_from_session('cs_test_bare')

    assert account.ledger_entries.balance_seconds() == SECONDS_PER_HOUR
    assert STATISTIC_REVENUE not in metric_dispatched.statistic_keys()
    assert 'records no revenue' in caplog.text

    assert metric_dispatched.statistic_keys() == [
        'remi--funnel--purchases',
        'remi--funnel--paying-clients',
    ]


def test_purchases_count_a_paying_client_only_on_the_first(
    metric_dispatched: MetricExecutorFake,
    stripe_fake: StripeFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    account = create_test_account()
    metadata = {'account_id': str(account.pk), 'seconds': str(SECONDS_PER_HOUR)}

    for session_id in ('cs_test_first', 'cs_test_second'):
        stripe_fake.session_add(
            metadata=metadata,
            payment_status='paid',
            session_id=session_id,
        )

    with django_capture_on_commit_callbacks(execute=True):
        for session_id in ('cs_test_first', 'cs_test_first', 'cs_test_second'):
            AccountLedgerEntry.services.factory.purchase_from_session(session_id)

    assert metric_dispatched.statistic_keys() == [
        'remi--funnel--purchases',
        'remi--funnel--paying-clients',
        'remi--funnel--purchases',
    ]


def test_signup_with_a_campaign_promo_counts_both_under_that_campaign(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    create_test_promo_code(campaign=CampaignChoices.WIB, code='WIB2026')

    with django_capture_on_commit_callbacks(execute=True):
        account_create(client, promo_code='WIB2026')
        account_create(client, email='morgan@example.com')

    wib = Account.objects.get(email='avery@example.com')
    general = Account.objects.get(email='morgan@example.com')
    entry = AccountLedgerEntry.objects.promos().get()

    assert metric_dispatched.dispatched == [
        MetricDispatch(
            f'WIB2026:account_ledger.accountledgerentry:{entry.pk}',
            'remi--funnel--promos',
            'remi--wib',
            VALUE_ONE,
        ),
        MetricDispatch(
            f'signup:account.account:{wib.pk}',
            'remi--funnel--signups',
            'remi--wib',
            VALUE_ONE,
        ),
        MetricDispatch(
            f'signup:account.account:{general.pk}',
            'remi--funnel--signups',
            'remi--general',
            VALUE_ONE,
        ),
    ]


def test_visit_beacon_counts_a_scan_only_for_a_qr_code(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        for source in ('link', 'qr'):
            fields = {'campaign': 'wib', 'source': source}

            assert _beacon_send(client, FUNNEL_VISIT_PATH, fields).status_code == 204

    assert metric_dispatched.dispatched == [
        MetricDispatch('link', 'remi--funnel--visits', 'remi--wib', VALUE_ONE),
        MetricDispatch('qr', 'remi--funnel--visits', 'remi--wib', VALUE_ONE),
        MetricDispatch('qr', 'remi--funnel--scans', 'remi--wib', VALUE_ONE),
    ]
