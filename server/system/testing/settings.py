from __future__ import annotations

from system.base_settings import *


DJANGO_SPIRE_REMOTE_API_KEY = ''
DJANGO_SPIRE_REMOTE_API_URL = ''
PASSWORD_HASHERS = ['django.contrib.auth.hashers.MD5PasswordHasher']
SENDGRID_API_KEY = ''
STRIPE_PUBLISHABLE_KEY = ''
STRIPE_SECRET_KEY = ''
STRIPE_WEBHOOK_SECRET = ''

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'HOST': environment_text(EnvironmentVariable.DATABASE_HOST) or '127.0.0.1',
        'NAME': environment_text(EnvironmentVariable.DATABASE_NAME) or 'remi',
        'OPTIONS': DATABASE_OPTIONS,
        'PASSWORD': environment_text(EnvironmentVariable.DATABASE_PASSWORD) or 'remi',
        'PORT': environment_text(EnvironmentVariable.DATABASE_PORT) or '55432',
        'USER': environment_text(EnvironmentVariable.DATABASE_USER) or 'remi',
    },
}
