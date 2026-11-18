from __future__ import annotations

import functools
import json
import os
import re
import shutil
import signal
import threading

from dataclasses import dataclass
from pathlib import Path
from typing_extensions import TYPE_CHECKING

from harness.world.constants import (
    WORLD_DATABASE_NAME,
    WORLD_FAKES_PORT_DEFAULT,
    WORLD_PORTAL_API_KEY,
    WORLD_PORTAL_PORT_DEFAULT,
    WORLD_PORT_MAX,
    WORLD_PORT_MIN,
    WORLD_REMI_PORT_DEFAULT,
    WORLD_STRIPE_PUBLISHABLE_KEY,
)
from harness.world.fakes import fakes_start
from harness.world.processes import (
    SERVER_DIRECTORY,
    portal_start,
    remi_database_drop,
    remi_start,
)

if TYPE_CHECKING:
    from types import FrameType

    from harness.world.fakes import FakesServer
    from harness.world.processes import ManagedProcess


REPOSITORY_DIRECTORY = SERVER_DIRECTORY.parent
WORLD_DIRECTORY = REPOSITORY_DIRECTORY / 'target' / 'world'
PORTAL_DIRECTORY_DEFAULT = REPOSITORY_DIRECTORY.parent / 'stratusadv-portal'
RUN_NAME_PATTERN = re.compile(r'[A-Za-z0-9_-]{1,48}')
RUNS_KEPT = 3
WATCH_WAIT_COUNT_MAX = 24 * 60 * 60
WATCH_WAIT_SECONDS = 1.0


@dataclass
class World:
    database_name: str
    descriptor: dict[str, object]
    fakes: FakesServer
    portal: ManagedProcess
    remi: ManagedProcess

    def stop(self) -> None:
        self.remi.stop()
        self.portal.stop()
        self.fakes.stop()
        remi_database_drop(self.database_name)


def main() -> None:
    run_name = os.environ.get('REMI_WORLD_RUN', 'run')
    descriptor_path = Path(os.environ.get('REMI_WORLD_DESCRIPTOR', WORLD_DIRECTORY / 'world.json'))
    stopping = threading.Event()
    stop_request = functools.partial(_stop_request, stopping=stopping)

    signal.signal(signal.SIGINT, stop_request)
    signal.signal(signal.SIGTERM, stop_request)

    world = world_start(run_name=run_name)

    try:
        descriptor_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor_path.write_text(json.dumps(world.descriptor, indent=4))
        print(f'remi world ready: {json.dumps(world.descriptor)}', flush=True)

        _world_watch(world, stopping)
    finally:
        world.stop()
        descriptor_path.unlink(missing_ok=True)


def _runs_prune(keep: int) -> None:
    if keep < 0:
        message = f'keep must not be negative: {keep}'
        raise ValueError(message)

    kept = {'cache', 'portal-venv'}
    runs = [path for path in WORLD_DIRECTORY.iterdir() if path.is_dir() if path.name not in kept]
    runs.sort(key=lambda path: path.stat().st_mtime, reverse=True)

    for stale in runs[keep:]:
        shutil.rmtree(stale)


def _port_read(name: str, default: int) -> int:
    if not name.startswith('REMI_WORLD_'):
        message = f'name must be a REMI_WORLD_ variable: {name!r}'
        raise ValueError(message)

    if not WORLD_PORT_MIN <= default <= WORLD_PORT_MAX:
        message = f'default must name a port from {WORLD_PORT_MIN} to {WORLD_PORT_MAX}: {default}'
        raise ValueError(message)

    text = os.environ.get(name, '').strip()

    if text == '':
        return default

    port = int(text)

    if not WORLD_PORT_MIN <= port <= WORLD_PORT_MAX:
        message = f'{name} must name a port from {WORLD_PORT_MIN} to {WORLD_PORT_MAX}, not {port}'
        raise ValueError(message)

    return port


def _stop_request(
    signal_number: int,
    frame: FrameType | None,
    *,
    stopping: threading.Event,
) -> None:
    if not isinstance(stopping, threading.Event):
        message = f'stopping must be a threading.Event: {type(stopping).__name__}'
        raise TypeError(message)

    _ = signal_number
    _ = frame

    stopping.set()


def _world_watch(world: World, stopping: threading.Event) -> None:
    if not isinstance(stopping, threading.Event):
        message = f'stopping must be a threading.Event: {type(stopping).__name__}'
        raise TypeError(message)

    for _ in range(WATCH_WAIT_COUNT_MAX):
        if stopping.wait(timeout=WATCH_WAIT_SECONDS):
            return

        for managed in (world.remi, world.portal):
            if managed.process.poll() is not None:
                message = f'the world {managed.name} exited {managed.process.returncode}'
                raise RuntimeError(message)

    message = f'the world ran {WATCH_WAIT_COUNT_MAX} watch waits without a stop request'
    raise RuntimeError(message)


def world_start(*, run_name: str) -> World:
    if RUN_NAME_PATTERN.fullmatch(run_name) is None:
        message = f'run_name must be 1 to 48 letters, digits, dashes, or underscores: {run_name!r}'
        raise ValueError(message)

    remi_port = _port_read('REMI_WORLD_REMI_PORT', WORLD_REMI_PORT_DEFAULT)
    fakes_port = _port_read('REMI_WORLD_FAKES_PORT', WORLD_FAKES_PORT_DEFAULT)
    portal_port = _port_read('REMI_WORLD_PORTAL_PORT', WORLD_PORTAL_PORT_DEFAULT)
    portal_directory = Path(os.environ.get('REMI_WORLD_PORTAL_DIRECTORY', PORTAL_DIRECTORY_DEFAULT))
    run_directory = WORLD_DIRECTORY / run_name

    if not (portal_directory / 'manage.py').exists():
        message = f'the world needs the stratusadv-portal checkout at {portal_directory}'
        raise FileNotFoundError(message)

    WORLD_DIRECTORY.mkdir(parents=True, exist_ok=True)
    _runs_prune(RUNS_KEPT - 1)
    run_directory.mkdir(parents=True, exist_ok=True)

    fakes = fakes_start(port=fakes_port, remi_url=f'http://127.0.0.1:{remi_port}')

    portal = portal_start(
        environment_directory=WORLD_DIRECTORY / 'portal-venv',
        port=portal_port,
        portal_directory=portal_directory,
        run_directory=run_directory,
    )

    environment_world = {
        'REMI_WORLD_FAKES_PORT': str(fakes_port),
        'REMI_WORLD_PORTAL_API_KEY': WORLD_PORTAL_API_KEY,
        'REMI_WORLD_PORTAL_PORT': str(portal_port),
    }

    database_name = f'{WORLD_DATABASE_NAME}_{run_name.replace("-", "_")}'

    remi = remi_start(
        database_name=database_name,
        environment_world=environment_world,
        port=remi_port,
        run_directory=run_directory,
    )

    descriptor = {
        'fakes_url': fakes.url,
        'portal_api_key': WORLD_PORTAL_API_KEY,
        'portal_url': portal.url,
        'remi_url': remi.url,
        'run_directory': str(run_directory),
        'stripe_publishable_key': WORLD_STRIPE_PUBLISHABLE_KEY,
    }

    return World(
        database_name=database_name,
        descriptor=descriptor,
        fakes=fakes,
        portal=portal,
        remi=remi,
    )
