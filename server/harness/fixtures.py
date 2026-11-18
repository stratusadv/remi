from __future__ import annotations

import pytest

from typing_extensions import TYPE_CHECKING
from urllib.request import OpenerDirector

from django.core.cache import cache

from django_spire.metric import metric as spire_metric

from app.checkout import client as checkout_client
from harness.metric import MetricExecutorFake
from harness.sendgrid import SENDGRID_API_KEY, SendgridFake
from harness.stripe import (
    STRIPE_PUBLISHABLE_KEY,
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
    StripeFake,
)
from system import base_settings

if TYPE_CHECKING:
    from pytest_django.fixtures import Settings


PRICE_CURRENCY = 'cad'
PRICE_HOUR_CENTS = 60
PRICE_HOURS = 50


@pytest.fixture(autouse=True)
def cache_isolated() -> None:
    cache.clear()


@pytest.fixture
def metric_dispatched(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
) -> MetricExecutorFake:
    executor = MetricExecutorFake()

    settings.DJANGO_SPIRE_REMOTE_API_KEY = 'metric-key-test'
    settings.DJANGO_SPIRE_REMOTE_API_URL = 'https://portal.example.com'

    monkeypatch.setattr(spire_metric, '_record_executor', executor)

    return executor


@pytest.fixture
def sendgrid_fake(monkeypatch: pytest.MonkeyPatch, settings: Settings) -> SendgridFake:
    fake = SendgridFake()

    settings.EMAIL_BACKEND = base_settings.EMAIL_BACKEND
    settings.SENDGRID_API_KEY = SENDGRID_API_KEY

    monkeypatch.setattr(OpenerDirector, 'open', fake.open)

    return fake


@pytest.fixture
def stripe_configured(settings: Settings) -> None:
    settings.REMI_PRICE_CURRENCY = PRICE_CURRENCY
    settings.REMI_PRICE_HOUR_CENTS = PRICE_HOUR_CENTS
    settings.STRIPE_PUBLISHABLE_KEY = STRIPE_PUBLISHABLE_KEY
    settings.STRIPE_SECRET_KEY = STRIPE_SECRET_KEY
    settings.STRIPE_WEBHOOK_SECRET = STRIPE_WEBHOOK_SECRET


@pytest.fixture
def stripe_fake(monkeypatch: pytest.MonkeyPatch, stripe_configured: None) -> StripeFake:
    _ = stripe_configured
    fake = StripeFake()

    monkeypatch.setattr(checkout_client, 'stripe_client', fake.client)

    return fake
