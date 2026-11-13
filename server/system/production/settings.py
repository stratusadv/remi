from __future__ import annotations

from django.core.exceptions import ImproperlyConfigured

from system.base_settings import *


CSRF_COOKIE_SECURE = True
MIDDLEWARE_SECURITY = 'django.middleware.security.SecurityMiddleware'
NINJA_NUM_PROXIES = 1
SECRET_KEY_PLACEHOLDERS = ('', 'MUST_BE_SET_IN_PRODUCTION')
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_SECONDS = 31_536_000
SECURE_SSL_REDIRECT = True
SESSION_COOKIE_SECURE = True
WSGI_APPLICATION = 'system.production.wsgi.application'

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'HOST': environment_text(EnvironmentVariable.DATABASE_HOST),
        'NAME': environment_text(EnvironmentVariable.DATABASE_NAME),
        'OPTIONS': DATABASE_OPTIONS,
        'PASSWORD': environment_text(EnvironmentVariable.DATABASE_PASSWORD),
        'PORT': environment_text(EnvironmentVariable.DATABASE_PORT) or '5432',
        'USER': environment_text(EnvironmentVariable.DATABASE_USER),
    },
}

if MIDDLEWARE[0] != MIDDLEWARE_SECURITY:
    message = f'WhiteNoise is placed after {MIDDLEWARE_SECURITY}, which must come first'
    raise ImproperlyConfigured(message)

MIDDLEWARE = [
    MIDDLEWARE_SECURITY,
    'whitenoise.middleware.WhiteNoiseMiddleware',
    *MIDDLEWARE[1:],
]

if SECRET_KEY in SECRET_KEY_PLACEHOLDERS:
    message = 'DJANGO_SECRET_KEY must be set to a secret value in production'
    raise ImproperlyConfigured(message)

if not ALLOWED_HOSTS:
    message = 'DJANGO_ALLOWED_HOSTS must name the host names production answers to'
    raise ImproperlyConfigured(message)

if DEBUG:
    message = 'DJANGO_DEBUG must be off in production'
    raise ImproperlyConfigured(message)

if not DATABASES['default']['HOST']:
    message = 'DATABASE_HOST must name the PostgreSQL server in production'
    raise ImproperlyConfigured(message)

if not DATABASES['default']['NAME']:
    message = 'DATABASE_NAME must name the PostgreSQL database in production'
    raise ImproperlyConfigured(message)
