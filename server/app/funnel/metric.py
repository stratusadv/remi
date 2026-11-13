from __future__ import annotations

import functools

from decimal import ROUND_HALF_UP, Decimal
from types import MappingProxyType
from typing_extensions import TYPE_CHECKING

from django.conf import settings
from django.db import transaction
from django.db.models import TextChoices

from django_spire.metric.domain.statistic.constants import (
    StatisticIntervalChoices,
    StatisticValueTypeChoices,
)
from django_spire.metric.metric import Metric

from app.funnel.choices import (
    CampaignChoices,
    FunnelPlatformChoices,
    FunnelSourceChoices,
)

if TYPE_CHECKING:
    from django.db.models import Model


CENTS_PER_DOLLAR = 100
METRIC_DOMAIN_KEY = 'remi'
METRIC_GROUP_FUNNEL_KEY = 'funnel'
METRIC_GROUP_SALES_KEY = 'sales'
METRIC_GROUP_USAGE_KEY = 'usage'
METRIC_HOURS_QUANTUM = Decimal('0.0001')
METRIC_REFERENCE_CHECKOUT = 'checkout'
METRIC_REFERENCE_LENGTH_MAX = 64
METRIC_REMOTE_TARGET = 'stratus-portal'
METRIC_REVENUE_CENTS_MAX = 99_999_999
METRIC_REVENUE_QUANTUM = Decimal('0.01')
METRIC_VALUE_ONE = Decimal(1)
SECONDS_PER_HOUR = 3600


class FunnelStatistic(TextChoices):
    ACTIVATIONS = 'activations', 'Activations'
    CHECKOUTS = 'checkouts', 'Checkouts started'
    DOWNLOADS = 'downloads', 'Downloads'
    PAYING_CLIENTS = 'paying-clients', 'Paying clients'
    PROMOS = 'promos', 'Promo codes redeemed'
    PURCHASES = 'purchases', 'Purchases'
    SCANS = 'scans', 'QR code scans'
    SIGNUPS = 'signups', 'Sign-ups'
    VISITS = 'visits', 'Landing page visits'


class SalesStatistic(TextChoices):
    REVENUE = 'revenue', 'Revenue'


class UsageStatistic(TextChoices):
    HOURS = 'hours', 'Hours transcribed'
    MEETINGS = 'meetings', 'Meetings transcribed'


METRIC_GROUP_KEYS = MappingProxyType({
    FunnelStatistic: METRIC_GROUP_FUNNEL_KEY,
    SalesStatistic: METRIC_GROUP_SALES_KEY,
    UsageStatistic: METRIC_GROUP_USAGE_KEY,
})


def metric_statistics(
    choices: type[TextChoices],
    value_type: StatisticValueTypeChoices,
) -> tuple[Metric.Statistic, ...]:
    if not issubclass(choices, TextChoices):
        message = f'choices must be a TextChoices subclass: {choices!r}'
        raise TypeError(message)

    if value_type not in StatisticValueTypeChoices.values:
        message = f'value_type must be one of {StatisticValueTypeChoices.values}: {value_type!r}'
        raise ValueError(message)

    statistics = tuple(
        Metric.Statistic(
            key=statistic.value,
            name=str(statistic.label),
            interval=StatisticIntervalChoices.DAILY,
            value_type=value_type,
        )
        for statistic in choices
    )

    if len(statistics) != len(choices):
        message = f'{choices.__name__} produced {len(statistics)} statistics'
        raise RuntimeError(message)

    return statistics


METRIC_SUBDOMAINS = tuple(
    Metric.SubDomain(key=campaign.value, name=str(campaign.label))
    for campaign in CampaignChoices
)

METRIC_GROUP_FUNNEL = Metric.StatisticGroup(
    key=METRIC_GROUP_FUNNEL_KEY,
    name='Funnel',
    statistics=metric_statistics(FunnelStatistic, StatisticValueTypeChoices.NUMBER),
)

METRIC_GROUP_SALES = Metric.StatisticGroup(
    key=METRIC_GROUP_SALES_KEY,
    name='Sales',
    statistics=metric_statistics(SalesStatistic, StatisticValueTypeChoices.CURRENCY),
)

METRIC_GROUP_USAGE = Metric.StatisticGroup(
    key=METRIC_GROUP_USAGE_KEY,
    name='Usage',
    statistics=metric_statistics(UsageStatistic, StatisticValueTypeChoices.NUMBER),
)

METRIC_GROUPS = (METRIC_GROUP_FUNNEL, METRIC_GROUP_SALES, METRIC_GROUP_USAGE)

METRIC_DOMAIN = Metric.Domain(
    key=METRIC_DOMAIN_KEY,
    name='remi',
    statistic_groups=METRIC_GROUPS,
    sub_domain_name='Campaign',
    subdomains=METRIC_SUBDOMAINS,
)


class RemiMetric(Metric):
    domains = [METRIC_DOMAIN]
    remote_target = METRIC_REMOTE_TARGET
    target = Metric.Target.REMOTE


def metric_hours(seconds: int) -> Decimal:
    if seconds <= 0:
        message = f'seconds must be positive: {seconds}'
        raise ValueError(message)

    hours = (Decimal(seconds) / SECONDS_PER_HOUR).quantize(
        METRIC_HOURS_QUANTUM,
        rounding=ROUND_HALF_UP,
    )

    if hours <= 0:
        message = f'{seconds} seconds rounded to {hours} hours'
        raise RuntimeError(message)

    return hours


def metric_revenue(cents: int) -> Decimal:
    if not 0 < cents <= METRIC_REVENUE_CENTS_MAX:
        message = f'cents must be 1 to {METRIC_REVENUE_CENTS_MAX}: {cents}'
        raise ValueError(message)

    revenue = (Decimal(cents) / CENTS_PER_DOLLAR).quantize(METRIC_REVENUE_QUANTUM)

    if revenue * CENTS_PER_DOLLAR != cents:
        message = f'{cents} cents converted to {revenue} dollars'
        raise RuntimeError(message)

    return revenue


def metric_record(
    campaign: str,
    statistic: FunnelStatistic | SalesStatistic | UsageStatistic,
    *,
    reference: str,
    source_model: Model | None = None,
    value: Decimal = METRIC_VALUE_ONE,
) -> None:
    if campaign not in CampaignChoices.values:
        message = f'campaign must be one of {CampaignChoices.values}: {campaign!r}'
        raise ValueError(message)

    if not isinstance(statistic, FunnelStatistic | SalesStatistic | UsageStatistic):
        message = (
            f'statistic must be a FunnelStatistic, SalesStatistic, or UsageStatistic: '
            f'{statistic!r}'
        )

        raise TypeError(message)

    if not 0 < len(reference) <= METRIC_REFERENCE_LENGTH_MAX:
        message = f'reference must be 1 to {METRIC_REFERENCE_LENGTH_MAX} characters: {reference!r}'
        raise ValueError(message)

    if value <= 0:
        message = f'value must be positive: {value}'
        raise ValueError(message)

    if source_model is not None:
        if source_model.pk is None:
            message = f'source_model must be saved: {source_model!r}'
            raise ValueError(message)

    if not metric_remote_configured():
        return

    group_key = METRIC_GROUP_KEYS[type(statistic)]
    references = [reference]

    record = functools.partial(
        RemiMetric.record,
        METRIC_DOMAIN_KEY,
        campaign,
        group_key,
        statistic.value,
        references,
        value,
        source_model=source_model,
    )

    transaction.on_commit(record)


def metric_remote_configured() -> bool:
    url = settings.DJANGO_SPIRE_REMOTE_API_URL
    api_key = settings.DJANGO_SPIRE_REMOTE_API_KEY

    if not isinstance(url, str):
        message = f'DJANGO_SPIRE_REMOTE_API_URL must be a str: {type(url).__name__}'
        raise TypeError(message)

    if not isinstance(api_key, str):
        message = f'DJANGO_SPIRE_REMOTE_API_KEY must be a str: {type(api_key).__name__}'
        raise TypeError(message)

    return url != '' and api_key != ''


def funnel_download_record(*, campaign: str, platform: str) -> None:
    if campaign not in CampaignChoices.values:
        message = f'campaign must be one of {CampaignChoices.values}: {campaign!r}'
        raise ValueError(message)

    if platform not in FunnelPlatformChoices.values:
        message = f'platform must be one of {FunnelPlatformChoices.values}: {platform!r}'
        raise ValueError(message)

    metric_record(campaign, FunnelStatistic.DOWNLOADS, reference=str(platform))


def funnel_visit_record(*, campaign: str, source: str) -> None:
    if campaign not in CampaignChoices.values:
        message = f'campaign must be one of {CampaignChoices.values}: {campaign!r}'
        raise ValueError(message)

    if source not in FunnelSourceChoices.values:
        message = f'source must be one of {FunnelSourceChoices.values}: {source!r}'
        raise ValueError(message)

    metric_record(campaign, FunnelStatistic.VISITS, reference=str(source))

    if source == FunnelSourceChoices.QR_CODE:
        metric_record(campaign, FunnelStatistic.SCANS, reference=str(source))
