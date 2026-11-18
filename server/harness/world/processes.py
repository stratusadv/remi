from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import time

import psycopg

from dataclasses import dataclass
from pathlib import Path

from psycopg import sql

from harness.world.constants import (
    WORLD_DATABASE_NAME,
    WORLD_PORTAL_API_KEY,
    WORLD_PORT_MAX,
    WORLD_PORT_MIN,
    WORLD_PROMOS,
)
from harness.world.http import http_request


DATABASE_NAME_BYTES_MAX = 63
ENVIRONMENT_PASSED = ('HOME', 'LANG', 'LC_ALL', 'PATH', 'TZ', 'UV_CACHE_DIR')
PORTAL_BOOT_TIMEOUT_SECONDS = 900
PORTAL_METRIC_REGISTRY = 'app.product.remi.metric.RemiMetric'
PORTAL_SETTINGS_MODULE = 'remi_world_portal_settings'
POLL_SECONDS = 0.25
READY_TIMEOUT_SECONDS = 120
REMI_DATABASE_ADMIN = 'remi'
SERVER_DIRECTORY = Path(__file__).resolve().parents[2]
STOP_TIMEOUT_SECONDS = 20

PORTAL_SETTINGS_SOURCE = """import importlib
import os

_base = importlib.import_module('system.testing.settings')

globals().update({name: getattr(_base, name) for name in dir(_base) if name.isupper()})

ALLOWED_HOSTS = ['127.0.0.1', 'localhost']
CACHES = {'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}}
DEBUG = False
SECRET_KEY = 'remi-world-portal-secret'

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': os.environ['REMI_WORLD_PORTAL_DATABASE'],
    },
}

STORAGES = {
    'default': {
        'BACKEND': 'django.core.files.storage.FileSystemStorage',
        'OPTIONS': {'location': os.environ['REMI_WORLD_PORTAL_MEDIA']},
    },
    'staticfiles': {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage'},
}
"""

REMI_SEED_SCRIPT = """
from app.promo_code.models import PromoCode

for campaign, code, hours, redemptions_max in {promos!r}:
    promo = PromoCode(
        campaign=campaign,
        code=code,
        hours=hours,
        redemptions_max=redemptions_max,
    )

    promo.services.save_model_obj()
"""

PORTAL_KEY_SCRIPT = """
from django_spire.api.choices import ApiPermissionChoices
from django_spire.api.models import ApiAccess

access = ApiAccess(name='remi world', permission=ApiPermissionChoices.DELETE)
access.set_key_and_save({key!r})
"""


@dataclass
class ManagedProcess:
    log_path: Path
    name: str
    process: subprocess.Popen[bytes]
    url: str

    def stop(self) -> None:
        if self.process.poll() is not None:
            return

        self.process.terminate()

        try:
            _ = self.process.wait(timeout=STOP_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            self.process.kill()
            _ = self.process.wait(timeout=STOP_TIMEOUT_SECONDS)


def environment_clean(overrides: dict[str, str]) -> dict[str, str]:
    if not all(isinstance(value, str) for value in overrides.values()):
        message = f'overrides must map each name to a str: {sorted(overrides)}'
        raise TypeError(message)

    inherited = {name: os.environ[name] for name in ENVIRONMENT_PASSED if name in os.environ}
    return {**inherited, 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUNBUFFERED': '1', **overrides}


def _command_run(
    command: list[str],
    *,
    cwd: Path,
    environment: dict[str, str],
    log_path: Path,
) -> None:
    if not command:
        message = 'command must name a program to run'
        raise ValueError(message)

    if not cwd.is_dir():
        message = f'cwd must be a directory: {cwd}'
        raise ValueError(message)

    if not all(isinstance(value, str) for value in environment.values()):
        message = f'environment must map each name to a str: {sorted(environment)}'
        raise TypeError(message)

    if not log_path.parent.is_dir():
        message = f'log_path must sit in an existing directory: {log_path}'
        raise ValueError(message)

    with log_path.open('ab') as log:
        completed = subprocess.run(
            command,
            check=False,
            cwd=cwd,
            env=environment,
            stderr=subprocess.STDOUT,
            stdout=log,
            timeout=PORTAL_BOOT_TIMEOUT_SECONDS,
        )

    if completed.returncode != 0:
        tail = log_path.read_text(errors='replace')[-3000:]
        message = f'{" ".join(command)} exited {completed.returncode}:\n{tail}'
        raise RuntimeError(message)


def ready_wait(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    log_path: Path,
    process: subprocess.Popen[bytes],
) -> None:
    if not url.startswith('http://'):
        message = f'url must be a plain http url: {url!r}'
        raise ValueError(message)

    if not isinstance(headers, dict | None):
        message = f'headers must be a dict or None, not {type(headers).__name__}'
        raise TypeError(message)

    if not log_path.is_file():
        message = f'log_path must name the log the process writes: {log_path}'
        raise ValueError(message)

    if not isinstance(process, subprocess.Popen):
        message = f'process must be a subprocess.Popen, not {type(process).__name__}'
        raise TypeError(message)

    deadline = time.monotonic() + READY_TIMEOUT_SECONDS

    while time.monotonic() < deadline:
        if process.poll() is not None:
            tail = log_path.read_text(errors='replace')[-3000:]
            message = f'the process behind {url} exited {process.returncode}:\n{tail}'
            raise RuntimeError(message)

        try:
            http_request(url, headers=headers, timeout=5)
        except OSError:
            time.sleep(POLL_SECONDS)
        else:
            return

    message = f'{url} did not answer within {READY_TIMEOUT_SECONDS} seconds'
    raise RuntimeError(message)


def portal_environment_ensure(
    *,
    environment_directory: Path,
    log_path: Path,
    portal_directory: Path,
) -> Path:
    if not environment_directory.is_absolute():
        message = f'environment_directory must be absolute: {environment_directory}'
        raise ValueError(message)

    if not log_path.parent.is_dir():
        message = f'log_path must sit in an existing directory: {log_path}'
        raise ValueError(message)

    if not (portal_directory / 'uv.lock').is_file():
        message = f'portal_directory must hold a uv.lock: {portal_directory}'
        raise ValueError(message)

    python = environment_directory / 'bin' / 'python'

    if python.exists():
        return python

    command = [
        'uv',
        'sync',
        '--project',
        str(portal_directory),
        '--frozen',
        '--no-dev',
        '--no-install-project',
    ]

    environment = environment_clean({'UV_PROJECT_ENVIRONMENT': str(environment_directory)})
    _command_run(command, cwd=SERVER_DIRECTORY, environment=environment, log_path=log_path)

    return python


def _portal_migrations_digest(*, environment_directory: Path, portal_directory: Path) -> str:
    if not (environment_directory / 'lib').is_dir():
        message = f'environment_directory must hold a lib directory: {environment_directory}'
        raise ValueError(message)

    if not (portal_directory / 'app').is_dir():
        message = f'portal_directory must hold an app directory: {portal_directory}'
        raise ValueError(message)

    digest = hashlib.sha256()
    roots = [portal_directory / 'app', environment_directory / 'lib']

    for root in roots:
        for path in sorted(root.rglob('migrations/*.py')):
            stat = path.stat()
            digest.update(f'{path.relative_to(root)}:{stat.st_size}:{stat.st_mtime_ns}\n'.encode())

    digest.update((portal_directory / 'uv.lock').read_bytes())

    return digest.hexdigest()[:16]


def portal_start(
    *,
    environment_directory: Path,
    port: int,
    portal_directory: Path,
    run_directory: Path,
) -> ManagedProcess:
    if not environment_directory.is_absolute():
        message = f'environment_directory must be absolute: {environment_directory}'
        raise ValueError(message)

    if not WORLD_PORT_MIN <= port <= WORLD_PORT_MAX:
        message = f'port must be from {WORLD_PORT_MIN} to {WORLD_PORT_MAX}: {port}'
        raise ValueError(message)

    if not (portal_directory / 'manage.py').is_file():
        message = f'portal_directory must hold manage.py: {portal_directory}'
        raise ValueError(message)

    if not run_directory.is_dir():
        message = f'run_directory must be an existing directory: {run_directory}'
        raise ValueError(message)

    directory = run_directory / 'portal'
    directory.mkdir(parents=True, exist_ok=True)
    log_path = directory / 'portal.log'

    python = portal_environment_ensure(
        environment_directory=environment_directory,
        portal_directory=portal_directory,
        log_path=log_path,
    )

    (directory / f'{PORTAL_SETTINGS_MODULE}.py').write_text(PORTAL_SETTINGS_SOURCE)

    database = directory / 'portal.sqlite3'
    environment = environment_clean({
        'DJANGO_SETTINGS_MODULE': PORTAL_SETTINGS_MODULE,
        'PYTHONPATH': f'{portal_directory}{os.pathsep}{directory}',
        'REMI_WORLD_PORTAL_DATABASE': str(database),
        'REMI_WORLD_PORTAL_MEDIA': str(directory / 'media'),
    })

    _portal_database_prepare(
        database=database,
        environment=environment,
        environment_directory=environment_directory,
        log_path=log_path,
        portal_directory=portal_directory,
        python=python,
    )

    serve = [str(python), 'manage.py', 'runserver', f'127.0.0.1:{port}', '--noreload']
    process = _process_spawn(
        serve,
        cwd=portal_directory,
        environment=environment,
        log_path=log_path,
    )

    url = f'http://127.0.0.1:{port}'
    probe = f'{url}/ds/api/v1/metric/domain/statistic/remi--funnel--visits/total'
    headers = {'X-API-Key': WORLD_PORTAL_API_KEY}

    ready_wait(probe, headers=headers, log_path=log_path, process=process)

    return ManagedProcess(log_path=log_path, name='portal', process=process, url=url)


def _portal_database_prepare(
    *,
    database: Path,
    environment: dict[str, str],
    environment_directory: Path,
    log_path: Path,
    portal_directory: Path,
    python: Path,
) -> None:
    if environment.get('REMI_WORLD_PORTAL_DATABASE') != str(database):
        message = f'environment must point the portal at {database}'
        raise ValueError(message)

    if not (environment_directory / 'lib').is_dir():
        message = f'environment_directory must hold a lib directory: {environment_directory}'
        raise ValueError(message)

    if not log_path.parent.is_dir():
        message = f'log_path must sit in an existing directory: {log_path}'
        raise ValueError(message)

    if not (portal_directory / 'manage.py').is_file():
        message = f'portal_directory must hold manage.py: {portal_directory}'
        raise ValueError(message)

    if not python.is_file():
        message = f'python must name an interpreter: {python}'
        raise ValueError(message)

    cache = environment_directory.parent / 'cache'
    cache.mkdir(parents=True, exist_ok=True)

    digest = _portal_migrations_digest(
        environment_directory=environment_directory,
        portal_directory=portal_directory,
    )

    cached = cache / f'portal-{digest}.sqlite3'

    if not cached.exists():
        building = cache / f'portal-{digest}.building.sqlite3'
        building.unlink(missing_ok=True)
        environment_building = {**environment, 'REMI_WORLD_PORTAL_DATABASE': str(building)}
        command = [str(python), 'manage.py', 'migrate', '--noinput']

        _command_run(
            command,
            cwd=portal_directory,
            environment=environment_building,
            log_path=log_path,
        )

        _ = building.replace(cached)

    shutil.copyfile(cached, database)

    manage = [str(python), 'manage.py']
    registry = [*manage, 'metric_build', '--registry', PORTAL_METRIC_REGISTRY]
    key = [*manage, 'shell', '-c', PORTAL_KEY_SCRIPT.format(key=WORLD_PORTAL_API_KEY)]

    _command_run(registry, cwd=portal_directory, environment=environment, log_path=log_path)
    _command_run(key, cwd=portal_directory, environment=environment, log_path=log_path)


def _process_spawn(
    command: list[str],
    *,
    cwd: Path,
    environment: dict[str, str],
    log_path: Path,
) -> subprocess.Popen[bytes]:
    if not command:
        message = 'command must name a program to run'
        raise ValueError(message)

    if not cwd.is_dir():
        message = f'cwd must be a directory: {cwd}'
        raise ValueError(message)

    if not all(isinstance(value, str) for value in environment.values()):
        message = f'environment must map each name to a str: {sorted(environment)}'
        raise TypeError(message)

    if not log_path.parent.is_dir():
        message = f'log_path must sit in an existing directory: {log_path}'
        raise ValueError(message)

    with log_path.open('ab') as log:
        return subprocess.Popen(
            command,
            cwd=cwd,
            env=environment,
            stderr=subprocess.STDOUT,
            stdout=log,
        )


def _database_statements(name: str, *, create: bool) -> None:
    if not name.startswith('remi_world'):
        message = f'the world only manages databases named remi_world*, not {name!r}'
        raise ValueError(message)

    connection = psycopg.connect(
        dbname='remi',
        host='127.0.0.1',
        password=REMI_DATABASE_ADMIN,
        port=55432,
        user=REMI_DATABASE_ADMIN,
        autocommit=True,
    )

    with connection:
        database = sql.Identifier(name)
        drop = sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(database)

        connection.execute(drop)

        if create:
            connection.execute(sql.SQL('CREATE DATABASE {} OWNER remi').format(database))


def remi_database_drop(name: str) -> None:
    if len(name.encode()) > DATABASE_NAME_BYTES_MAX:
        message = f'name must fit in {DATABASE_NAME_BYTES_MAX} bytes, a PostgreSQL name: {name!r}'
        raise ValueError(message)

    _database_statements(name, create=False)


def remi_database_reset(name: str) -> None:
    if len(name.encode()) > DATABASE_NAME_BYTES_MAX:
        message = f'name must fit in {DATABASE_NAME_BYTES_MAX} bytes, a PostgreSQL name: {name!r}'
        raise ValueError(message)

    _database_statements(name, create=True)


def remi_start(
    *,
    database_name: str,
    environment_world: dict[str, str],
    port: int,
    run_directory: Path,
) -> ManagedProcess:
    if not database_name.startswith(f'{WORLD_DATABASE_NAME}_'):
        message = f'database_name must name a {WORLD_DATABASE_NAME}_ database: {database_name!r}'
        raise ValueError(message)

    if not all(name.startswith('REMI_WORLD_') for name in environment_world):
        message = f'environment_world must hold REMI_WORLD_ variables: {sorted(environment_world)}'
        raise ValueError(message)

    if not WORLD_PORT_MIN <= port <= WORLD_PORT_MAX:
        message = f'port must be from {WORLD_PORT_MIN} to {WORLD_PORT_MAX}: {port}'
        raise ValueError(message)

    if not run_directory.is_dir():
        message = f'run_directory must be an existing directory: {run_directory}'
        raise ValueError(message)

    directory = run_directory / 'remi'
    directory.mkdir(parents=True, exist_ok=True)
    log_path = directory / 'remi.log'
    environment = environment_clean({
        **environment_world,
        'DJANGO_SETTINGS_MODULE': 'system.e2e.settings',
        'REMI_WORLD_DATABASE_NAME': database_name,
    })

    remi_database_reset(database_name)

    migrate = [sys.executable, 'manage.py', 'migrate', '--noinput']
    seed_script = REMI_SEED_SCRIPT.format(promos=WORLD_PROMOS)
    seed = [sys.executable, 'manage.py', 'shell', '-c', seed_script]

    _command_run(migrate, cwd=SERVER_DIRECTORY, environment=environment, log_path=log_path)
    _command_run(seed, cwd=SERVER_DIRECTORY, environment=environment, log_path=log_path)

    gunicorn = Path(sys.executable).parent / 'gunicorn'

    serve = [
        str(gunicorn),
        'system.production.wsgi',
        '--bind',
        f'127.0.0.1:{port}',
        '--workers',
        '1',
        '--threads',
        '32',
        '--access-logfile',
        '-',
    ]

    process = _process_spawn(
        serve,
        cwd=SERVER_DIRECTORY,
        environment=environment,
        log_path=log_path,
    )

    url = f'http://127.0.0.1:{port}'

    ready_wait(f'{url}/checkout/return/', log_path=log_path, process=process)

    return ManagedProcess(log_path=log_path, name='remi', process=process, url=url)
