from __future__ import annotations

import os

import pytest

from typing_extensions import TYPE_CHECKING

from harness.world.world import World, world_start

if TYPE_CHECKING:
    from collections.abc import Generator


@pytest.fixture(scope='session')
def world_live() -> Generator[World]:
    if os.environ.get('PYTEST_XDIST_WORKER', '') != '':
        message = 'the live world binds fixed ports, so system tests run without xdist workers'
        raise RuntimeError(message)

    world = world_start(run_name=f'pytest-{os.getpid()}')

    try:
        yield world
    finally:
        world.stop()
