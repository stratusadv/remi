from __future__ import annotations

from pathlib import Path

from django.utils.csp import CSP

from system.environment import (
    EnvironmentVariable,
    environment_currency,
    environment_flag,
    environment_integer,
    environment_list,
    environment_offers,
    environment_publishable_key,
    environment_text,
)


ALLOWED_HOSTS = environment_list(EnvironmentVariable.DJANGO_ALLOWED_HOSTS)
BASE_DIR = Path(__file__).resolve().parent.parent
DEBUG = environment_flag(EnvironmentVariable.DJANGO_DEBUG)
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
DEFAULT_FROM_EMAIL = 'remi <noreply@remirememberthat.com>'
DJANGO_SITE_DOMAIN = environment_text(EnvironmentVariable.DJANGO_SITE_DOMAIN) or 'localhost:8000'
DJANGO_SITE_NAME = 'remi'
DJANGO_SPIRE_REMOTE_API_KEY = environment_text(EnvironmentVariable.DJANGO_SPIRE_REMOTE_API_KEY)
DJANGO_SPIRE_REMOTE_API_URL = environment_text(EnvironmentVariable.DJANGO_SPIRE_REMOTE_API_URL)
EMAIL_BACKEND = 'app.core.mail.SendgridTimeoutBackend'
LANGUAGE_CODE = 'en-us'
ROOT_URLCONF = 'system.urls'
SECRET_KEY = environment_text(EnvironmentVariable.DJANGO_SECRET_KEY) or 'MUST_BE_SET_IN_PRODUCTION'
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
SENDGRID_API_KEY = environment_text(EnvironmentVariable.SENDGRID_API_KEY)
SENDGRID_SANDBOX_MODE_IN_DEBUG = False
SENDGRID_TRACK_CLICKS_PLAIN = False
SITE_ID = 1
STATIC_ROOT = BASE_DIR / 'static'
STATIC_URL = 'static/'
STRIPE_PUBLISHABLE_KEY = environment_publishable_key(EnvironmentVariable.STRIPE_PUBLISHABLE_KEY)
STRIPE_SECRET_KEY = environment_text(EnvironmentVariable.STRIPE_SECRET_KEY)
STRIPE_WEBHOOK_SECRET = environment_text(EnvironmentVariable.STRIPE_WEBHOOK_SECRET)
TIME_ZONE = 'America/Edmonton'
USE_I18N = False
USE_TZ = True

CACHES = {
    'default': {
        'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
        'OPTIONS': {'MAX_ENTRIES': 10_000},
    },
}

DATABASE_OPTIONS = {
    'keepalives': 1,
    'keepalives_count': 3,
    'keepalives_idle': 30,
    'keepalives_interval': 10,
}

REMI_ASK_BURST_COUNT = environment_integer(
    EnvironmentVariable.REMI_ASK_BURST_COUNT,
    default=20,
    maximum=10_000,
    minimum=1,
)

REMI_ASK_BURST_SECONDS = environment_integer(
    EnvironmentVariable.REMI_ASK_BURST_SECONDS,
    default=600,
    maximum=86_400,
    minimum=1,
)

REMI_ASK_PACE_SECONDS = environment_integer(
    EnvironmentVariable.REMI_ASK_PACE_SECONDS,
    default=300,
    maximum=86_400,
    minimum=1,
)

REMI_ASK_TOKENS_ESTIMATE = environment_integer(
    EnvironmentVariable.REMI_ASK_TOKENS_ESTIMATE,
    default=20_000,
    maximum=1_000_000,
    minimum=1,
)

REMI_ASK_TOKENS_SOFT_CAP = environment_integer(
    EnvironmentVariable.REMI_ASK_TOKENS_SOFT_CAP,
    default=4_000_000,
    maximum=1_000_000_000,
    minimum=1,
)

REMI_ASK_WINDOW_DAYS = environment_integer(
    EnvironmentVariable.REMI_ASK_WINDOW_DAYS,
    default=30,
    maximum=365,
    minimum=1,
)

REMI_OFFERS = environment_offers(
    EnvironmentVariable.REMI_OFFERS,
    default='10:1000,50:5000,200:20000',
)

REMI_PRICE_CURRENCY = environment_currency(
    EnvironmentVariable.REMI_PRICE_CURRENCY,
    default='cad',
)

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.messages',
    'django.contrib.sessions',
    'django.contrib.sites',
    'django.contrib.staticfiles',
    'ninja',
    'django_spire.core',
    'django_spire.history',
    'django_spire.history.activity',
    'django_spire.metric',
    'django_spire.metric.domain',
    'app.account.apps.AccountConfig',
    'app.account.ledger.apps.AccountLedgerConfig',
    'app.account.question.apps.AccountQuestionConfig',
    'app.checkout.apps.CheckoutConfig',
    'app.funnel.apps.FunnelConfig',
    'app.promo_code.apps.PromoCodeConfig',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'app.funnel.middleware.FunnelCorsMiddleware',
    'django.middleware.csp.ContentSecurityPolicyMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django_spire.history.activity.middleware.ActivityUserMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

SECURE_CSP = {
    'base-uri': [CSP.SELF],
    'form-action': [CSP.SELF],
    'frame-ancestors': [CSP.NONE],
    'object-src': [CSP.NONE],
}

TEMPLATES = [
    {
        'APP_DIRS': True,
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'OPTIONS': {
            'context_processors': [
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
                'django.template.context_processors.request',
            ],
        },
    },
]

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
]

LOGGING = {
    'disable_existing_loggers': False,
    'handlers': {'console': {'class': 'logging.StreamHandler'}},
    'root': {'handlers': ['console'], 'level': 'INFO'},
    'version': 1,
}
