from __future__ import annotations

import os
import re
import signal
import socket
import subprocess
import time

import pytest

from pathlib import Path
from typing_extensions import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterator

    from playwright.sync_api import Page, Route, WebSocketRoute


pytest_plugins = 'limelight.pytest_plugin'

DEMO_HOST = '127.0.0.1'
DEMO_PORT = 1525
DEMO_ADDRESS = (DEMO_HOST, DEMO_PORT)
DEMO_URL = f'http://{DEMO_HOST}:{DEMO_PORT}'
HMR_SOCKET = re.compile(r'^ws://[^/]+/\?token=')
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
STRIPE_ROUTE = 'https://js.stripe.com/**'
STRIPE_STANDIN_TYPE = 'application/javascript'

STRIPE_STANDIN = """
window.Stripe = function () {
    return {
        createPaymentMethod: function () {
            return Promise.resolve({ paymentMethod: { id: 'pm_standin' } })
        },
        initCheckoutElementsSdk: function () {
            var handlers = {}
            var total = { amount: '$20.00', minorUnitsAmount: 2000 }
            var session = {
                currency: 'cad',
                email: 'avery@example.com',
                minorUnitsAmountDivisor: 100,
                total: { total: total },
            }

            var actions = {
                confirm: function () { return Promise.resolve({ type: 'success', session }) },
                getSession: function () { return session },
            }

            var element = {
                destroy: function () {},
                mount: function (host) {
                    host.innerHTML = '<input aria-label="Card number" value="4242 4242 4242 4242">'
                    setTimeout(function () { handlers.ready({ elementType: 'payment' }) }, 0)
                },
                on: function (event, handler) { handlers[event] = handler; return element },
            }

            return {
                changeAppearance: function () {},
                createPaymentElement: function () { return element },
                loadActions: function () { return Promise.resolve({ type: 'success', actions }) },
            }
        },
    }
}

window.Stripe.version = 'endive'
"""


def _hmr_socket_stub(websocket: WebSocketRoute) -> None:
    assert HMR_SOCKET.match(websocket.url) is not None
    assert not websocket.url.endswith('=')


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


def _stripe_standin_serve(route: Route) -> None:
    assert route.request.url.startswith('https://js.stripe.com/')
    assert route.request.method == 'GET'

    route.fulfill(body=STRIPE_STANDIN, content_type=STRIPE_STANDIN_TYPE)


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


@pytest.fixture
def standins(page: Page) -> None:
    assert not page.is_closed()
    assert page.url == 'about:blank'

    page.route(STRIPE_ROUTE, _stripe_standin_serve)
    page.route_web_socket(HMR_SOCKET, _hmr_socket_stub)
