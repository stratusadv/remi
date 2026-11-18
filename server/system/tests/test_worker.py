from __future__ import annotations

import os
import subprocess
import sys

import pytest

from pathlib import Path
from tempfile import TemporaryDirectory
from types import MappingProxyType
from typing_extensions import TYPE_CHECKING

from app.account.constants import SECONDS_PER_HOUR, TOPUP_BALANCE_SECONDS
from app.account.tests.factories import create_test_account

if TYPE_CHECKING:
    from types import ModuleType


JOB_ID = '86dfb1d3b0140ecf2fd59075421f1cb5'
SERVER_DIRECTORY = Path(__file__).resolve().parents[2]
WORKER_TIMEOUT_SECONDS = 60

PRODUCTION_ENVIRONMENT = MappingProxyType({
    'DATABASE_HOST': 'db.example.test',
    'DATABASE_NAME': 'remi',
    'DJANGO_ALLOWED_HOSTS': 'api.example.test',
    'DJANGO_SECRET_KEY': 'production-secret-for-the-worker-test',
})


def _worker_import(name: str, monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    assert name in ('development_worker', 'worker')

    monkeypatch.setenv('ROBIT_KEY', 'worker-key-for-the-test')
    monkeypatch.delitem(sys.modules, name, raising=False)

    if name == 'worker':
        import worker

        return worker

    import development_worker

    return development_worker


def test_worker_refuses_to_start_without_a_key_for_its_dashboard() -> None:
    with TemporaryDirectory() as directory_name:
        directory = Path(directory_name)
        inherited = {name: os.environ[name] for name in ('HOME', 'PATH') if name in os.environ}
        environment = {**inherited, **PRODUCTION_ENVIRONMENT, 'ROBIT_KEY': '  '}
        script = f'import sys; sys.path.insert(0, {str(SERVER_DIRECTORY)!r}); import worker'
        command = [sys.executable, '-c', script]

        assert not any(directory.iterdir())

        started = subprocess.run(
            command,
            capture_output=True,
            check=False,
            cwd=directory,
            env=environment,
            text=True,
            timeout=WORKER_TIMEOUT_SECONDS,
        )

        assert list(directory.iterdir()) == []

    assert started.returncode != 0
    assert 'ROBIT_KEY must be set, because the worker dashboard can run jobs' in started.stderr


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('name', ['development_worker', 'worker'])
def test_worker_job_tops_each_complimentary_account_back_up(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
) -> None:
    assert (SERVER_DIRECTORY / f'{name}.py').is_file()

    module = _worker_import(name, monkeypatch)

    assert module.__name__ == name

    complimentary = create_test_account(email='staff@example.com')
    paying = create_test_account(email='client@example.com', seconds=SECONDS_PER_HOUR)

    _ = complimentary.services.processor.complimentary_start(reference='topup:test:start')

    complimentary.services.processor.charge(job_id=JOB_ID, seconds=SECONDS_PER_HOUR)
    module.complimentary_topup_job()

    assert complimentary.ledger_entries.balance_seconds() == TOPUP_BALANCE_SECONDS
    assert complimentary.ledger_entries.grants().count() == 2
    assert paying.ledger_entries.balance_seconds() == SECONDS_PER_HOUR
    assert not paying.ledger_entries.grants().exists()
    assert str(module.worker.name) == 'remi'
