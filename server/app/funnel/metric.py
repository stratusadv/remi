from __future__ import annotations

import functools
import re

from decimal import ROUND_HALF_UP, Decimal
from types import MappingProxyType

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
    FunnelPageChoices,
    FunnelPlatformChoices,
)


METRIC_DOMAIN_KEY = 'remi'
METRIC_EVENT_CLICK = 'click'
METRIC_EVENT_LEAD = 'lead'
METRIC_EVENT_REDEMPTION = 'redemption'
METRIC_EVENT_SIGNUP = 'signup'
METRIC_GROUP_KEY = 'remi-metric'
METRIC_HOURS_QUANTUM = Decimal('0.0001')
METRIC_QUALIFIER_COMPLETED = 'completed'
METRIC_QUALIFIER_DOWNLOAD = 'download'
METRIC_QUALIFIER_PROMO_CODE = 'promo-code'
METRIC_REFERENCE_LENGTH_MAX = 64
METRIC_REFERENCE_SEPARATOR = ':'
METRIC_REMOTE_TARGET = 'stratus-portal'
METRIC_SEGMENT_COUNT_MAX = 3
METRIC_SEGMENT_PATTERN = re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*')
METRIC_SUB_DOMAIN_KEY = 'metrics'
METRIC_VALUE_ONE = Decimal(1)
SECONDS_PER_HOUR = 3600

METRIC_PLATFORM_QUALIFIERS = MappingProxyType({
    FunnelPlatformChoices.LINUX: 'linux',
    FunnelPlatformChoices.MACOS: 'mac',
    FunnelPlatformChoices.WINDOWS: 'windows',
})


class MetricAction(TextChoices):
    ASK_FOLDER_QUESTION = 'ask-folder-question', 'Ask folder question'
    ASK_LIBRARY_QUESTION = 'ask-library-question', 'Ask library question'
    ASK_NOTE_QUESTION = 'ask-note-question', 'Ask note question'
    CHANGE_THEME = 'change-theme', 'Change theme'
    CHAT_NEW = 'new-chat', 'New chat'
    FOLDER_CREATED = 'new-folder-created', 'New folder created'
    HOURS_TRANSCRIBED = 'hours-transcribed', 'Hours transcribed'
    IN_APP_RECORDING = 'in-app-recording', 'In-app recording'
    MEETING_TRANSCRIBED = 'meeting-transcribed', 'Meeting transcribed'
    PURCHASE_HOURS = 'purchase-hours', 'Purchase hours'
    TEMPLATE_NEW = 'new-template', 'New template'
    UPLOAD_RECORDING = 'upload-recording', 'Upload recording'


class MetricStatistic(TextChoices):
    ACQUISITION = 'acquisition', 'Acquisition'
    ACTION = 'action', 'Action'


METRIC_ACTIONS_REPORTED = frozenset({
    MetricAction.ASK_FOLDER_QUESTION,
    MetricAction.ASK_LIBRARY_QUESTION,
    MetricAction.ASK_NOTE_QUESTION,
    MetricAction.CHANGE_THEME,
    MetricAction.CHAT_NEW,
    MetricAction.FOLDER_CREATED,
    MetricAction.IN_APP_RECORDING,
    MetricAction.TEMPLATE_NEW,
    MetricAction.UPLOAD_RECORDING,
})

METRIC_STATISTICS = tuple(
    Metric.Statistic(
        key=statistic.value,
        name=str(statistic.label),
        interval=StatisticIntervalChoices.DAILY,
        value_type=StatisticValueTypeChoices.NUMBER,
    )
    for statistic in MetricStatistic
)

METRIC_GROUP = Metric.StatisticGroup(
    key=METRIC_GROUP_KEY,
    name='Remi Metric',
    statistics=METRIC_STATISTICS,
)

METRIC_GROUPS = (METRIC_GROUP,)
METRIC_SUB_DOMAIN = Metric.SubDomain(key=METRIC_SUB_DOMAIN_KEY, name='Metrics')
METRIC_SUB_DOMAINS = (METRIC_SUB_DOMAIN,)

METRIC_DOMAIN = Metric.Domain(
    key=METRIC_DOMAIN_KEY,
    name='remi',
    description='Acquisition and in-product action counts for remi.',
    statistic_groups=METRIC_GROUPS,
    sub_domain_name='Subdomain',
    subdomains=METRIC_SUB_DOMAINS,
)


class RemiMetric(Metric):
    domains = [METRIC_DOMAIN]
    remote_target = METRIC_REMOTE_TARGET
    target = Metric.Target.REMOTE


def funnel_click_record(*, campaign: str, page: str) -> None:
    if not funnel_page_belongs(campaign=campaign, page=page):
        message = f'the {campaign} campaign has no {page} page'
        raise ValueError(message)

    if campaign == CampaignChoices.GENERAL:
        metric_record(MetricStatistic.ACQUISITION, METRIC_EVENT_CLICK, page)
    else:
        metric_record(MetricStatistic.ACQUISITION, METRIC_EVENT_CLICK, campaign, page)


def funnel_download_record(*, campaign: str, platform: str) -> None:
    if campaign not in CampaignChoices.values:
        message = f'campaign must be one of {CampaignChoices.values}: {campaign!r}'
        raise ValueError(message)

    if platform not in FunnelPlatformChoices.values:
        message = f'platform must be one of {FunnelPlatformChoices.values}: {platform!r}'
        raise ValueError(message)

    qualifier = METRIC_PLATFORM_QUALIFIERS[FunnelPlatformChoices(platform)]

    metric_record(MetricStatistic.ACQUISITION, METRIC_EVENT_CLICK, METRIC_QUALIFIER_DOWNLOAD)

    metric_record(
        MetricStatistic.ACQUISITION,
        METRIC_EVENT_CLICK,
        METRIC_QUALIFIER_DOWNLOAD,
        qualifier,
    )

    if campaign != CampaignChoices.GENERAL:
        metric_record(
            MetricStatistic.ACQUISITION,
            METRIC_EVENT_CLICK,
            campaign,
            METRIC_QUALIFIER_DOWNLOAD,
        )


def funnel_lead_record(*, campaign: str) -> None:
    if campaign not in CampaignChoices.values:
        message = f'campaign must be one of {CampaignChoices.values}: {campaign!r}'
        raise ValueError(message)

    metric_record(MetricStatistic.ACQUISITION, METRIC_EVENT_LEAD, METRIC_QUALIFIER_PROMO_CODE)

    if campaign != CampaignChoices.GENERAL:
        metric_record(
            MetricStatistic.ACQUISITION,
            METRIC_EVENT_LEAD,
            campaign,
            METRIC_QUALIFIER_PROMO_CODE,
        )


def funnel_page_belongs(*, campaign: str, page: str) -> bool:
    if campaign not in CampaignChoices.values:
        message = f'campaign must be one of {CampaignChoices.values}: {campaign!r}'
        raise ValueError(message)

    if page not in FunnelPageChoices.values:
        message = f'page must be one of {FunnelPageChoices.values}: {page!r}'
        raise ValueError(message)

    return (page == FunnelPageChoices.LANDING) == (campaign == CampaignChoices.GENERAL)


def funnel_redemption_record(*, campaign: str) -> None:
    if campaign not in CampaignChoices.values:
        message = f'campaign must be one of {CampaignChoices.values}: {campaign!r}'
        raise ValueError(message)

    metric_record(MetricStatistic.ACQUISITION, METRIC_EVENT_REDEMPTION, METRIC_QUALIFIER_PROMO_CODE)

    if campaign != CampaignChoices.GENERAL:
        metric_record(
            MetricStatistic.ACQUISITION,
            METRIC_EVENT_REDEMPTION,
            campaign,
            METRIC_QUALIFIER_PROMO_CODE,
        )


def funnel_signup_record(*, campaign: str) -> None:
    if campaign not in CampaignChoices.values:
        message = f'campaign must be one of {CampaignChoices.values}: {campaign!r}'
        raise ValueError(message)

    metric_record(MetricStatistic.ACQUISITION, METRIC_EVENT_SIGNUP, METRIC_QUALIFIER_COMPLETED)

    if campaign != CampaignChoices.GENERAL:
        metric_record(
            MetricStatistic.ACQUISITION,
            METRIC_EVENT_SIGNUP,
            campaign,
            METRIC_QUALIFIER_PROMO_CODE,
        )


def metric_action_record(action: MetricAction, *, value: Decimal = METRIC_VALUE_ONE) -> None:
    if not isinstance(action, MetricAction):
        message = f'action must be a MetricAction: {action!r}'
        raise TypeError(message)

    if value <= 0:
        message = f'value must be positive: {value}'
        raise ValueError(message)

    metric_record(MetricStatistic.ACTION, action.value, value=value)


def metric_charge_record(seconds: int) -> None:
    if seconds <= 0:
        message = f'seconds must be positive: {seconds}'
        raise ValueError(message)

    hours = metric_hours(seconds)

    metric_action_record(MetricAction.MEETING_TRANSCRIBED)
    metric_action_record(MetricAction.HOURS_TRANSCRIBED, value=hours)


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


def metric_record(
    statistic: MetricStatistic,
    *segments: str,
    value: Decimal = METRIC_VALUE_ONE,
) -> None:
    if not isinstance(statistic, MetricStatistic):
        message = f'statistic must be a MetricStatistic: {statistic!r}'
        raise TypeError(message)

    if value <= 0:
        message = f'value must be positive: {value}'
        raise ValueError(message)

    reference = metric_reference(statistic, *segments)

    if not metric_remote_configured():
        return

    references = [reference]

    record = functools.partial(
        RemiMetric.record,
        METRIC_DOMAIN_KEY,
        METRIC_SUB_DOMAIN_KEY,
        METRIC_GROUP_KEY,
        statistic.value,
        references,
        value,
    )

    transaction.on_commit(record)


def metric_reference(statistic: MetricStatistic, *segments: str) -> str:
    if not isinstance(statistic, MetricStatistic):
        message = f'statistic must be a MetricStatistic: {statistic!r}'
        raise TypeError(message)

    if not 0 < len(segments) <= METRIC_SEGMENT_COUNT_MAX:
        message = f'a reference carries 1 to {METRIC_SEGMENT_COUNT_MAX} segments: {segments!r}'
        raise ValueError(message)

    for segment in segments:
        if METRIC_SEGMENT_PATTERN.fullmatch(segment) is None:
            message = f'a reference segment is lowercase words joined by hyphens: {segment!r}'
            raise ValueError(message)

    parts = (METRIC_DOMAIN_KEY, statistic.value, *segments)
    reference = METRIC_REFERENCE_SEPARATOR.join(parts)

    if len(reference) > METRIC_REFERENCE_LENGTH_MAX:
        message = f'a reference is at most {METRIC_REFERENCE_LENGTH_MAX} characters: {reference!r}'
        raise ValueError(message)

    return reference


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
