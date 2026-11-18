import os
import re

from enum import Enum, auto

from django.core.exceptions import ImproperlyConfigured


CURRENCY_CODES_DECIMAL_THREE = ('bhd', 'jod', 'kwd', 'omr', 'tnd')

CURRENCY_CODES_DECIMAL_ZERO = (
    'bif',
    'clp',
    'djf',
    'gnf',
    'jpy',
    'kmf',
    'krw',
    'mga',
    'pyg',
    'rwf',
    'vnd',
    'vuv',
    'xaf',
    'xof',
    'xpf',
)

CURRENCY_PATTERN = re.compile(r'[a-z]{3}')
INTEGER_PATTERN = re.compile(r'[0-9]{1,15}')
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
    REMI_API_HOST = auto()
    REMI_API_KEY_NOTES = auto()
    REMI_API_KEY_TRANSCRIPTION = auto()
    REMI_ASK_BURST_COUNT = auto()
    REMI_ASK_BURST_SECONDS = auto()
    REMI_ASK_PACE_SECONDS = auto()
    REMI_ASK_TOKENS_ESTIMATE = auto()
    REMI_ASK_TOKENS_SOFT_CAP = auto()
    REMI_ASK_WINDOW_DAYS = auto()
    REMI_CHAT_DAY_MAX = auto()
    REMI_CHAT_MINUTE_MAX = auto()
    REMI_EMBEDDINGS_DAY_MAX = auto()
    REMI_EMBEDDINGS_MINUTE_MAX = auto()
    REMI_PRICE_CURRENCY = auto()
    REMI_PRICE_HOUR_CENTS = auto()
    ROBIT_KEY = auto()
    SENDGRID_API_KEY = auto()
    STRIPE_PUBLISHABLE_KEY = auto()
    STRIPE_SECRET_KEY = auto()
    STRIPE_WEBHOOK_SECRET = auto()


def environment_currency(variable: EnvironmentVariable, *, default: str) -> str:
    if CURRENCY_PATTERN.fullmatch(default) is None:
        message = f'{variable.name} has a default of {default!r}, not a lowercase three-letter code'
        raise ImproperlyConfigured(message)

    value = environment_text(variable).lower() or default

    if CURRENCY_PATTERN.fullmatch(value) is None:
        message = f'{variable.name} must be a three-letter ISO currency code, not {value!r}'
        raise ImproperlyConfigured(message)

    if value in CURRENCY_CODES_DECIMAL_THREE:
        message = f'{variable.name} is {value!r}, which Stripe counts in thousandths, not cents'
        raise ImproperlyConfigured(message)

    if value in CURRENCY_CODES_DECIMAL_ZERO:
        message = f'{variable.name} is {value!r}, which Stripe counts in whole units, not cents'
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
