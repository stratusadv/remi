from __future__ import annotations

import hashlib
import logging

from types import MappingProxyType
from typing_extensions import NamedTuple
from urllib.parse import urlencode

from python_http_client.exceptions import HTTPError

from django.conf import settings
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.mail import EmailMultiAlternatives
from django.core.validators import validate_email
from django.template.loader import render_to_string
from django.utils import timezone

from app.core.exceptions import EmailUnavailableError
from app.funnel.choices import CampaignChoices
from app.funnel.constants import FUNNEL_PAGE_URL_GENERAL, FUNNEL_PAGE_URL_WIB_DOWNLOAD
from app.funnel.promo import funnel_promo_issue


FUNNEL_EMAIL_ADDRESS_LENGTH_MAX = 254
FUNNEL_EMAIL_ADDRESS_WINDOW_SECONDS = 3_600
FUNNEL_EMAIL_DAY_COUNT_MAX = 2_000
FUNNEL_EMAIL_DAY_FULL_MESSAGE = 'The server has sent all the email it sends in a day.'
FUNNEL_EMAIL_DAY_KEY_SECONDS = 172_800
FUNNEL_EMAIL_FAILED_MESSAGE = 'The email did not send. Try again in a minute.'
FUNNEL_EMAIL_SOURCE = 'email'
FUNNEL_EMAIL_TEMPLATE_HTML = 'funnel/email.html'
FUNNEL_EMAIL_TEMPLATE_TEXT = 'funnel/email.txt'
FUNNEL_EMAIL_UNCONFIGURED_MESSAGE = 'The server is not set up to send email.'
logger = logging.getLogger(__name__)


class FunnelEmail(NamedTuple):
    eyebrow: str
    page_url: str
    subject: str


FUNNEL_EMAILS = MappingProxyType({
    CampaignChoices.GENERAL: FunnelEmail(
        eyebrow='Meeting notes, written for you',
        page_url=FUNNEL_PAGE_URL_GENERAL,
        subject='Download remi',
    ),
    CampaignChoices.WIB: FunnelEmail(
        eyebrow='Women in Business Conference',
        page_url=FUNNEL_PAGE_URL_WIB_DOWNLOAD,
        subject='Your remi code for Women in Business',
    ),
})


def funnel_email_address_clean(address: str) -> str:
    if not isinstance(address, str):
        message = f'address must be a str: {type(address).__name__}'
        raise TypeError(message)

    address_clean = address.strip()

    if not 0 < len(address_clean) <= FUNNEL_EMAIL_ADDRESS_LENGTH_MAX:
        message = f'an email address has 1 to {FUNNEL_EMAIL_ADDRESS_LENGTH_MAX} characters'
        raise ValueError(message)

    try:
        validate_email(address_clean)
    except ValidationError as error:
        message = 'the address is not an email address'
        raise ValueError(message) from error

    return address_clean


def funnel_email_build(*, address: str, campaign: str) -> EmailMultiAlternatives:
    if campaign not in CampaignChoices.values:
        message = f'campaign must be one of {CampaignChoices.values}: {campaign!r}'
        raise ValueError(message)

    if address != funnel_email_address_clean(address):
        message = 'address must arrive stripped and validated'
        raise ValueError(message)

    content = FUNNEL_EMAILS[CampaignChoices(campaign)]
    promo = funnel_promo_issue(address=address, campaign=campaign)
    query = {'utm_source': FUNNEL_EMAIL_SOURCE}

    if promo is not None:
        query = {'code': promo.code, 'utm_source': FUNNEL_EMAIL_SOURCE}

    context = {
        'code': '' if promo is None else promo.code,
        'download_url': f'{content.page_url}?{urlencode(query)}',
        'eyebrow': content.eyebrow,
        'hours': 0 if promo is None else promo.hours,
    }

    body = render_to_string(FUNNEL_EMAIL_TEMPLATE_TEXT, context)
    html = render_to_string(FUNNEL_EMAIL_TEMPLATE_HTML, context)
    recipients = [address]

    email = EmailMultiAlternatives(
        subject=content.subject,
        body=body,
        from_email=settings.DEFAULT_FROM_EMAIL,
        to=recipients,
    )

    email.attach_alternative(html, 'text/html')

    return email


def funnel_email_configured() -> bool:
    api_key = settings.SENDGRID_API_KEY

    if not isinstance(api_key, str):
        message = f'SENDGRID_API_KEY must be a str: {type(api_key).__name__}'
        raise TypeError(message)

    return api_key != ''


def funnel_email_day_count_next() -> int:
    day_key = f'funnel-email-day:{timezone.localdate().isoformat()}'

    cache.add(day_key, 0, timeout=FUNNEL_EMAIL_DAY_KEY_SECONDS)

    return cache.incr(day_key)


def funnel_email_deliver(
    *,
    address_key: str,
    campaign: str,
    email: EmailMultiAlternatives,
) -> None:
    if address_key == '':
        message = 'address_key must be non-empty'
        raise ValueError(message)

    if campaign not in CampaignChoices.values:
        message = f'campaign must be one of {CampaignChoices.values}: {campaign!r}'
        raise ValueError(message)

    if len(email.to) != 1:
        message = f'a funnel email goes to one address, not {len(email.to)}'
        raise ValueError(message)

    try:
        email.send()
    except (HTTPError, OSError):
        cache.delete(address_key)
        logger.exception('SendGrid did not confirm the %s email', campaign)

        raise EmailUnavailableError(FUNNEL_EMAIL_FAILED_MESSAGE) from None


def funnel_email_send(*, address: str, campaign: str) -> None:
    if campaign not in CampaignChoices.values:
        message = f'campaign must be one of {CampaignChoices.values}: {campaign!r}'
        raise ValueError(message)

    if address != funnel_email_address_clean(address):
        message = 'address must arrive stripped and validated'
        raise ValueError(message)

    if not funnel_email_configured():
        raise EmailUnavailableError(FUNNEL_EMAIL_UNCONFIGURED_MESSAGE)

    email = funnel_email_build(address=address, campaign=campaign)
    digest = hashlib.sha256(address.casefold().encode()).hexdigest()
    address_key = f'funnel-email-address:{digest}'

    if not cache.add(address_key, campaign, timeout=FUNNEL_EMAIL_ADDRESS_WINDOW_SECONDS):
        return

    if funnel_email_day_count_next() > FUNNEL_EMAIL_DAY_COUNT_MAX:
        cache.delete(address_key)

        raise EmailUnavailableError(FUNNEL_EMAIL_DAY_FULL_MESSAGE)

    funnel_email_deliver(address_key=address_key, campaign=campaign, email=email)
