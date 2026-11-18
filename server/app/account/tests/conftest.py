from __future__ import annotations

import pytest

from typing_extensions import TYPE_CHECKING

from app.account.tests.simulation_scenarios import world_build
from app.checkout import client as checkout_client

if TYPE_CHECKING:
    from django.test import Client

    from pytest_django.fixtures import Settings

    from app.account.tests.simulation_engine import RemiWorld


@pytest.fixture
def world(client: Client, monkeypatch: pytest.MonkeyPatch, settings: Settings) -> RemiWorld:
    built = world_build(client, monkeypatch, settings)

    assert built.client is client
    assert checkout_client.stripe_client == built.stripe.client

    return built
