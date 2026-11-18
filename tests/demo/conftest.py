from __future__ import annotations

import os
import signal
import socket
import subprocess
import time

import pytest

from pathlib import Path
from typing_extensions import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterator


pytest_plugins = 'limelight.pytest_plugin'

DEMO_HOST = '127.0.0.1'
DEMO_PORT = 1525
DEMO_ADDRESS = (DEMO_HOST, DEMO_PORT)
DEMO_URL = f'http://{DEMO_HOST}:{DEMO_PORT}'
ROOT = Path(__file__).resolve().parents[2]

SERVER_COMMAND = (
    'bun',
    'run',
    'dev',
    '--host',
    DEMO_HOST,
    '--port',
    str(DEMO_PORT),
    '--strictPort',
)

SERVER_STOP_SECONDS = 10
SERVER_WAIT_ATTEMPTS = 300
SERVER_WAIT_SECONDS = 0.1


def _server_stop(process: subprocess.Popen[bytes]) -> None:
    assert process.pid > 0
    assert process.args == SERVER_COMMAND

    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)

    process.wait(timeout=SERVER_STOP_SECONDS)

    assert process.returncode is not None


def _server_wait(process: subprocess.Popen[bytes]) -> bool:
    assert process.pid > 0
    assert process.returncode is None

    for _ in range(SERVER_WAIT_ATTEMPTS):
        with socket.socket() as connection:
            if connection.connect_ex(DEMO_ADDRESS) == 0:
                return True

        if process.poll() is not None:
            return False

        time.sleep(SERVER_WAIT_SECONDS)

    return False


@pytest.fixture(scope='session')
def base_url() -> Iterator[str]:
    assert ROOT.joinpath('package.json').is_file()

    with socket.socket() as connection:
        if connection.connect_ex(DEMO_ADDRESS) == 0:
            message = f'Another server already answers on {DEMO_URL}.'
            raise RuntimeError(message)

    process = subprocess.Popen(
        SERVER_COMMAND,
        cwd=ROOT,
        start_new_session=True,
        stdout=subprocess.DEVNULL,
    )

    if not _server_wait(process):
        _server_stop(process)
        message = f'The dev server did not answer on {DEMO_URL}.'
        raise RuntimeError(message)

    yield DEMO_URL

    _server_stop(process)
