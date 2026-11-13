from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv


load_dotenv(Path(__file__).resolve().parents[2] / 'development.env')

from system.base_settings import *


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

DEBUG = True
