from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

from pathlib import Path
from types import MappingProxyType
from typing_extensions import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Mapping
    from typing_extensions import Any


PRODUCTION_ENVIRONMENT = MappingProxyType({
    'DATABASE_HOST': 'db.example.test',
    'DATABASE_NAME': 'remi',
    'DJANGO_ALLOWED_HOSTS': 'api.example.test',
    'DJANGO_SECRET_KEY': 'production-secret-for-the-settings-test',
})

SERVER_DIRECTORY = Path(__file__).resolve().parents[2]
SETTINGS_TIMEOUT_SECONDS = 60

SETTINGS_MODULES = (
    'system.development.settings',
    'system.production.settings',
    'system.testing.settings',
)

SETTINGS_REPORT = """
import json
import {module} as settings

names = [
    'CSRF_COOKIE_SECURE',
    'DATABASES',
    'DEBUG',
    'MIDDLEWARE',
    'SECURE_HSTS_SECONDS',
    'SECURE_SSL_REDIRECT',
    'SESSION_COOKIE_SECURE',
]

print(json.dumps({{name: getattr(settings, name, None) for name in names}}))
"""


def _environment(overrides: Mapping[str, str]) -> dict[str, str]:
    assert 'HOME' not in overrides
    assert 'PATH' not in overrides

    inherited = {name: os.environ[name] for name in ('HOME', 'PATH') if name in os.environ}
    return {**inherited, **overrides}


def _settings_load(module: str, overrides: Mapping[str, str]) -> subprocess.CompletedProcess[str]:
    assert module in SETTINGS_MODULES
    assert 'DJANGO_SETTINGS_MODULE' not in overrides

    script = SETTINGS_REPORT.format(module=module)
    command = [sys.executable, '-c', script]

    return subprocess.run(
        command,
        capture_output=True,
        check=False,
        cwd=SERVER_DIRECTORY,
        env=_environment(overrides),
        text=True,
        timeout=SETTINGS_TIMEOUT_SECONDS,
    )


def _settings_read(module: str, overrides: Mapping[str, str]) -> dict[str, Any]:
    assert module in SETTINGS_MODULES
    assert 'DJANGO_SETTINGS_MODULE' not in overrides

    loaded = _settings_load(module, overrides)

    if loaded.returncode != 0:
        message = f'{module} did not load: {loaded.stderr}'
        raise AssertionError(message)

    return json.loads(loaded.stdout)


def test_production_settings_turn_on_https_and_put_static_files_behind_security() -> None:
    settings = _settings_read('system.production.settings', PRODUCTION_ENVIRONMENT)

    assert settings['DEBUG'] is False
    assert settings['CSRF_COOKIE_SECURE'] is True
    assert settings['SESSION_COOKIE_SECURE'] is True
    assert settings['SECURE_SSL_REDIRECT'] is True
    assert settings['SECURE_HSTS_SECONDS'] == 31_536_000

    middleware = settings['MIDDLEWARE']

    assert middleware[:3] == [
        'django.middleware.security.SecurityMiddleware',
        'whitenoise.middleware.WhiteNoiseMiddleware',
        'app.core.middleware.RemoteAddressMiddleware',
    ]
    assert middleware.count('django.middleware.security.SecurityMiddleware') == 1

    database = settings['DATABASES']['default']

    assert database['HOST'] == 'db.example.test'
    assert database['NAME'] == 'remi'
    assert database['PORT'] == '5432'


@pytest.mark.parametrize(
    ('override', 'message'),
    [
        ({'DJANGO_SECRET_KEY': ''}, 'DJANGO_SECRET_KEY must be set to a secret value'),
        (
            {'DJANGO_SECRET_KEY': 'MUST_BE_SET_IN_PRODUCTION'},
            'DJANGO_SECRET_KEY must be set to a secret value',
        ),
        ({'DJANGO_ALLOWED_HOSTS': ' , '}, 'DJANGO_ALLOWED_HOSTS must name the host names'),
        ({'DJANGO_DEBUG': '1'}, 'DJANGO_DEBUG must be off in production'),
        ({'DATABASE_HOST': ''}, 'DATABASE_HOST must name the PostgreSQL server'),
        ({'DATABASE_NAME': ''}, 'DATABASE_NAME must name the PostgreSQL database'),
        ({'DJANGO_DEBUG': 'yes'}, "DJANGO_DEBUG must be 0 or 1, not 'yes'"),
    ],
)
def test_production_settings_refuse_to_load_without_each_required_value(
    override: dict[str, str],
    message: str,
) -> None:
    assert len(override) == 1

    environment = {**PRODUCTION_ENVIRONMENT, **override}
    loaded = _settings_load('system.production.settings', environment)

    assert loaded.returncode != 0
    assert 'ImproperlyConfigured' in loaded.stderr
    assert message in loaded.stderr


def test_production_settings_refuse_middleware_that_does_not_start_with_security() -> None:
    script = (
        'import system.base_settings as base\n'
        "base.MIDDLEWARE.insert(0, 'django.middleware.common.CommonMiddleware')\n"
        'import system.production.settings\n'
    )

    command = [sys.executable, '-c', script]

    loaded = subprocess.run(
        command,
        capture_output=True,
        check=False,
        cwd=SERVER_DIRECTORY,
        env=_environment(PRODUCTION_ENVIRONMENT),
        text=True,
        timeout=SETTINGS_TIMEOUT_SECONDS,
    )

    assert loaded.returncode != 0
    assert 'WhiteNoise is placed after' in loaded.stderr


def test_development_settings_debug_against_the_local_database_unless_told_otherwise() -> None:
    defaults = _settings_read('system.development.settings', {})
    overridden = _settings_read('system.development.settings', {'DATABASE_PORT': '5999'})
    database = defaults['DATABASES']['default']

    assert defaults['DEBUG'] is True
    assert (database['HOST'], database['NAME'], database['PORT']) == ('127.0.0.1', 'remi', '55432')
    assert overridden['DATABASES']['default']['PORT'] == '5999'
    assert defaults['SECURE_SSL_REDIRECT'] is not True


def test_testing_settings_send_nothing_to_stripe_sendgrid_or_the_portal() -> None:
    script = (
        'import system.testing.settings as settings\n'
        'names = ["DJANGO_SPIRE_REMOTE_API_KEY", "DJANGO_SPIRE_REMOTE_API_URL", '
        '"SENDGRID_API_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY", '
        '"STRIPE_WEBHOOK_SECRET"]\n'
        'print([getattr(settings, name) for name in names])\n'
    )

    secrets = {
        'DJANGO_SPIRE_REMOTE_API_KEY': 'metric-key',
        'DJANGO_SPIRE_REMOTE_API_URL': 'https://portal.example.test/ds',
        'SENDGRID_API_KEY': 'SG.leaked',
        'STRIPE_PUBLISHABLE_KEY': 'pk_test_leaked',
        'STRIPE_SECRET_KEY': 'sk_test_leaked',
        'STRIPE_WEBHOOK_SECRET': 'whsec_leaked',
    }

    command = [sys.executable, '-c', script]

    loaded = subprocess.run(
        command,
        capture_output=True,
        check=True,
        cwd=SERVER_DIRECTORY,
        env=_environment(secrets),
        text=True,
        timeout=SETTINGS_TIMEOUT_SECONDS,
    )

    assert loaded.stdout.strip() == "['', '', '', '', '', '']"


def test_production_wsgi_application_loads_under_the_production_settings() -> None:
    script = (
        'import system.production.wsgi as wsgi\n'
        'from django.conf import settings\n'
        'print(callable(wsgi.application), settings.SETTINGS_MODULE)\n'
    )

    command = [sys.executable, '-c', script]

    loaded = subprocess.run(
        command,
        capture_output=True,
        check=True,
        cwd=SERVER_DIRECTORY,
        env=_environment(PRODUCTION_ENVIRONMENT),
        text=True,
        timeout=SETTINGS_TIMEOUT_SECONDS,
    )

    assert loaded.stdout.strip() == 'True system.production.settings'
