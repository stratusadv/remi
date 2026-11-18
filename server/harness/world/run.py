from __future__ import annotations

import json
import os
import subprocess
import sys

from harness.world.world import WORLD_DIRECTORY, world_start


COMMAND_SEPARATOR = '--'
DESCRIPTOR_KEYS = frozenset({'fakes_url', 'portal_api_key', 'portal_url', 'remi_url'})


def main() -> None:
    command = command_of(sys.argv[1:])
    returncode = _world_command_run(command)

    sys.exit(returncode)


def _world_command_run(command: list[str]) -> int:
    if not command:
        message = 'command must name a program to run against the world'
        raise ValueError(message)

    world = world_start(run_name=f'run-{os.getpid()}')
    descriptor_path = WORLD_DIRECTORY / f'world-{os.getpid()}.json'

    try:
        descriptor_path.write_text(json.dumps(world.descriptor, indent=4))
        environment = environment_of(world.descriptor, str(descriptor_path))
        completed = subprocess.run(command, check=False, env=environment)
    finally:
        world.stop()
        descriptor_path.unlink(missing_ok=True)

    return completed.returncode


def command_of(arguments: list[str]) -> list[str]:
    if not all(isinstance(argument, str) for argument in arguments):
        message = f'arguments must be strs: {arguments!r}'
        raise TypeError(message)

    command = arguments[1:] if arguments[:1] == [COMMAND_SEPARATOR] else arguments

    if not command:
        message = 'name the command to run against the world after --'
        raise ValueError(message)

    return command


def environment_of(descriptor: dict[str, object], descriptor_path: str) -> dict[str, str]:
    if not descriptor.keys() >= DESCRIPTOR_KEYS:
        message = f'descriptor lacks {sorted(DESCRIPTOR_KEYS - descriptor.keys())}'
        raise ValueError(message)

    if not descriptor_path.endswith('.json'):
        message = f'descriptor_path must name a JSON file: {descriptor_path!r}'
        raise ValueError(message)

    return {
        **os.environ,
        'REMI_WORLD_DESCRIPTOR': descriptor_path,
        'REMI_WORLD_FAKES_URL': str(descriptor['fakes_url']),
        'REMI_WORLD_PORTAL_API_KEY': str(descriptor['portal_api_key']),
        'REMI_WORLD_PORTAL_URL': str(descriptor['portal_url']),
        'REMI_WORLD_REMI_URL': str(descriptor['remi_url']),
    }


if __name__ == '__main__':
    main()
