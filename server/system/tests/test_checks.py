from __future__ import annotations

import io
import os
import re
import subprocess
import sys

import pytest

from pathlib import Path
from types import MappingProxyType

from django.conf import settings
from django.core.management import call_command


CHECK_ID_PATTERN = re.compile(r'\(([a-z_]+\.[EW]\d{3})\)')
CHECKS_TIMEOUT_SECONDS = 120
DEPLOY_WARNINGS_ACCEPTED = frozenset({'security.W021'})
SERVER_DIRECTORY = Path(__file__).resolve().parents[2]

PRODUCTION_ENVIRONMENT = MappingProxyType({
    'DATABASE_HOST': 'db.example.test',
    'DATABASE_NAME': 'remi',
    'DJANGO_ALLOWED_HOSTS': 'api.example.test',
    'DJANGO_SECRET_KEY': 'Wn9xQ2p4Lr7Tz1Kc8Vb3Hd6Js0Mf5Ga2Ye7Ui4Oq9Pw1Ra8Sb3Tc6Ud0Ve5Wf2Xg',
    'DJANGO_SETTINGS_MODULE': 'system.production.settings',
})


@pytest.mark.django_db
def test_models_and_migrations_agree() -> None:
    output = io.StringIO()

    call_command('makemigrations', '--check', '--dry-run', stdout=output)

    assert output.getvalue().strip() == 'No changes detected'


def test_system_checks_find_nothing_under_the_testing_settings() -> None:
    assert settings.SETTINGS_MODULE == 'system.testing.settings'

    output = io.StringIO()

    call_command('check', stdout=output)

    assert output.getvalue().strip() == 'System check identified no issues (0 silenced).'


def test_deploy_checks_under_the_production_settings_raise_only_the_preload_advisory() -> None:
    inherited = {name: os.environ[name] for name in ('HOME', 'PATH') if name in os.environ}
    environment = {**inherited, **PRODUCTION_ENVIRONMENT}
    command = [sys.executable, 'manage.py', 'check', '--deploy']

    checked = subprocess.run(
        command,
        capture_output=True,
        check=False,
        cwd=SERVER_DIRECTORY,
        env=environment,
        text=True,
        timeout=CHECKS_TIMEOUT_SECONDS,
    )

    reported = frozenset(CHECK_ID_PATTERN.findall(checked.stdout + checked.stderr))

    assert checked.returncode == 0, checked.stderr
    assert reported == DEPLOY_WARNINGS_ACCEPTED, checked.stdout + checked.stderr
    assert 'System check identified 1 issue (0 silenced).' in checked.stdout + checked.stderr
