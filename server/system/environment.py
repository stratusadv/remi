import os
import re

from enum import Enum, auto

from django.core.exceptions import ImproperlyConfigured


CURRENCY_PATTERN = re.compile(r'[a-z]{3}')
INTEGER_PATTERN = re.compile(r'[0-9]{1,15}')
OFFER_HOURS_MAX = 10_000
OFFER_HOURS_MIN = 1
OFFER_PATTERN = re.compile(r'([0-9]{1,6}):([0-9]{1,6})')
OFFER_PRICE_CENTS_MAX = 100_000
OFFER_PRICE_CENTS_MIN = 50
OFFERS_MAX = 4
STRIPE_PUBLISHABLE_KEY_PATTERN = re.compile(r'pk_(?:live|test)_[A-Za-z0-9]{1,250}')


class EnvironmentVariable(Enum):
    DATABASE_HOST = auto()
    DATABASE_NAME = auto()
    DATABASE_PASSWORD = auto()
    DATABASE_PORT = auto()
    DATABASE_USER = auto()
    DJANGO_ALLOWED_HOSTS = auto()
    DJANGO_DEBUG = auto()
    DJANGO_SECRET_KEY = auto()
    DJANGO_SITE_DOMAIN = auto()
    DJANGO_SPIRE_REMOTE_API_KEY = auto()
    DJANGO_SPIRE_REMOTE_API_URL = auto()
    REMI_ASK_BURST_COUNT = auto()
    REMI_ASK_BURST_SECONDS = auto()
    REMI_ASK_PACE_SECONDS = auto()
    REMI_ASK_TOKENS_ESTIMATE = auto()
    REMI_ASK_TOKENS_SOFT_CAP = auto()
    REMI_ASK_WINDOW_DAYS = auto()
    REMI_OFFERS = auto()
    REMI_PRICE_CURRENCY = auto()
    ROBIT_KEY = auto()
    SENDGRID_API_KEY = auto()
    STRIPE_PUBLISHABLE_KEY = auto()
    STRIPE_SECRET_KEY = auto()
    STRIPE_WEBHOOK_SECRET = auto()


def _offer_parse(variable: EnvironmentVariable, item: str) -> tuple[int, int]:
    if item == '':
        message = f'{variable.name} lists an empty offer; remove the stray comma'
        raise ImproperlyConfigured(message)

    match = OFFER_PATTERN.fullmatch(item)

    if match is None:
        message = f'{variable.name} lists hours:price_cents pairs, and {item!r} is not one'
        raise ImproperlyConfigured(message)

    hours = int(match[1])
    price_cents = int(match[2])

    if not OFFER_HOURS_MIN <= hours <= OFFER_HOURS_MAX:
        message = (
            f'{variable.name} offers {hours} hours, outside '
            f'{OFFER_HOURS_MIN} to {OFFER_HOURS_MAX}'
        )

        raise ImproperlyConfigured(message)

    if not OFFER_PRICE_CENTS_MIN <= price_cents <= OFFER_PRICE_CENTS_MAX:
        message = (
            f'{variable.name} prices {hours} hours at {price_cents} cents, outside '
            f'{OFFER_PRICE_CENTS_MIN} to {OFFER_PRICE_CENTS_MAX}'
        )

        raise ImproperlyConfigured(message)

    return hours, price_cents


def environment_currency(variable: EnvironmentVariable, *, default: str) -> str:
    if CURRENCY_PATTERN.fullmatch(default) is None:
        message = f'{variable.name} has a default of {default!r}, not a lowercase three-letter code'
        raise ImproperlyConfigured(message)

    value = environment_text(variable).lower() or default

    if CURRENCY_PATTERN.fullmatch(value) is None:
        message = f'{variable.name} must be a three-letter ISO currency code, not {value!r}'
        raise ImproperlyConfigured(message)

    return value


def environment_flag(variable: EnvironmentVariable) -> bool:
    value = environment_text(variable)

    if value not in ('', '0', '1'):
        message = f'{variable.name} must be 0 or 1, not {value!r}'
        raise ImproperlyConfigured(message)

    return value == '1'


def environment_integer(
    variable: EnvironmentVariable,
    *,
    default: int,
    maximum: int,
    minimum: int,
) -> int:
    if not minimum <= default <= maximum:
        message = f'{variable.name} has a default of {default}, outside {minimum} to {maximum}'
        raise ImproperlyConfigured(message)

    text = environment_text(variable)

    if text == '':
        return default

    if INTEGER_PATTERN.fullmatch(text) is None:
        message = f'{variable.name} must be a whole number, not {text!r}'
        raise ImproperlyConfigured(message)

    value = int(text)

    if not minimum <= value <= maximum:
        message = f'{variable.name} is {value}, outside {minimum} to {maximum}'
        raise ImproperlyConfigured(message)

    return value


def environment_list(variable: EnvironmentVariable) -> list[str]:
    text = environment_text(variable)

    return [item.strip() for item in text.split(',') if item.strip() != '']


def environment_offers(variable: EnvironmentVariable, *, default: str) -> dict[int, int]:
    if default.strip() == '':
        message = f'{variable.name} has no default offers, and a server needs at least one'
        raise ImproperlyConfigured(message)

    text = environment_text(variable) or default
    items = [item.strip() for item in text.split(',')]

    if len(items) > OFFERS_MAX:
        message = f'{variable.name} lists {len(items)} offers, more than {OFFERS_MAX}'
        raise ImproperlyConfigured(message)

    offers = {}

    for item in items:
        hours, price_cents = _offer_parse(variable, item)

        if hours in offers:
            message = f'{variable.name} lists {hours} hours more than once'
            raise ImproperlyConfigured(message)

        offers[hours] = price_cents

    return dict(sorted(offers.items()))


def environment_publishable_key(variable: EnvironmentVariable) -> str:
    value = environment_text(variable)

    if value == '':
        return value

    if STRIPE_PUBLISHABLE_KEY_PATTERN.fullmatch(value) is None:
        message = f'{variable.name} must be a Stripe publishable key, starting pk_live_ or pk_test_'
        raise ImproperlyConfigured(message)

    return value


def environment_text(variable: EnvironmentVariable) -> str:
    if not isinstance(variable, EnvironmentVariable):
        message = f'variable must be an EnvironmentVariable: {type(variable).__name__}'
        raise TypeError(message)

    return os.environ.get(variable.name, '').strip()
