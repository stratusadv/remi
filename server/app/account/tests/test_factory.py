from __future__ import annotations

import re

import pytest

from functools import partialmethod
from typing_extensions import TYPE_CHECKING

from app.account.constants import ACCOUNT_EMAIL_LENGTH_MAX
from app.account.models import Account
from app.account.services import factory_service
from app.account.services.factory_service import AccountFactoryService
from app.account.tests.factories import create_test_account
from app.core.exceptions import PromoInvalidError, RequestInvalidError
from app.promo_code.constants import PROMO_CODE_LENGTH_MAX
from app.promo_code.tests.factories import create_test_promo_code
from harness.api import ACCOUNT_PATH, api_post

if TYPE_CHECKING:
    from collections.abc import Callable

    from pytest_django.fixtures import DjangoCaptureOnCommitCallbacks

    from django.db.models import Model
    from django.test import Client

    from harness.metric import MetricExecutorFake


pytestmark = pytest.mark.django_db


def _save_reported_as_update(
    service: AccountFactoryService,
    *,
    save: Callable[[AccountFactoryService], tuple[Model, bool]],
) -> tuple[Model, bool]:
    assert service.model_obj_is_new

    saved, _ = save(service)

    assert saved.pk is not None

    return saved, False


def test_account_create_trims_the_name_and_email_it_stores(client: Client) -> None:
    body = {
        'email': '  avery@example.com\t',
        'name': '\n Avery Quinn  ',
        'promo_code': '   ',
        'region': 'CA-AB',
    }

    response = api_post(client, ACCOUNT_PATH, body=body)
    account = Account.objects.get()

    assert response.status_code == 201
    assert response.json()['account']['email'] == 'avery@example.com'
    assert (account.email, account.name) == ('avery@example.com', 'Avery Quinn')
    assert not account.ledger_entries.exists()


def test_account_create_with_an_overlong_promo_code_creates_nothing(client: Client) -> None:
    code = 'P' * (PROMO_CODE_LENGTH_MAX + 1)
    body = {'email': 'avery@example.com', 'name': 'Avery', 'promo_code': code, 'region': 'CA-AB'}
    response = api_post(client, ACCOUNT_PATH, body=body)
    message = f'A promo code has at most {PROMO_CODE_LENGTH_MAX} characters.'
    error = {'code': 'promo_invalid', 'message': message, 'type': 'billing_error'}

    assert response.status_code == 400
    assert response.json() == {'error': error}
    assert Account.objects.count() == 0


def test_account_create_with_a_refused_promo_rolls_back_the_account_and_its_metric(
    client: Client,
    metric_dispatched: MetricExecutorFake,
    django_capture_on_commit_callbacks: DjangoCaptureOnCommitCallbacks,
) -> None:
    create_test_promo_code(code='SPENT', redemptions_max=0)

    with django_capture_on_commit_callbacks(execute=True) as callbacks:
        body = {
            'email': 'avery@example.com',
            'name': 'Avery',
            'promo_code': 'SPENT',
            'region': 'CA-AB',
        }

        response = api_post(client, ACCOUNT_PATH, body=body)

    assert response.status_code == 400
    assert response.json()['error']['code'] == 'promo_invalid'
    assert Account.objects.count() == 0
    assert callbacks == []
    assert metric_dispatched.statistic_keys() == []


def test_email_validation_takes_the_longest_address_and_refuses_one_character_more() -> None:
    overlong = 'a' * (ACCOUNT_EMAIL_LENGTH_MAX - len('@example.com') + 1) + '@example.com'
    longest = 'a' * (ACCOUNT_EMAIL_LENGTH_MAX - len('@example.com')) + '@example.com'
    message = f'Enter an email address of at most {ACCOUNT_EMAIL_LENGTH_MAX} characters.'

    assert len(longest) == ACCOUNT_EMAIL_LENGTH_MAX
    assert len(overlong) == ACCOUNT_EMAIL_LENGTH_MAX + 1

    factory_service._email_validate(longest)

    with pytest.raises(RequestInvalidError, match=re.escape(message)):
        factory_service._email_validate(overlong)

    with pytest.raises(RequestInvalidError, match=re.escape('Enter a valid email address.')):
        factory_service._email_validate('avery@')


def test_account_factory_bound_to_a_saved_account_refuses_to_create_another() -> None:
    account = create_test_account()

    assert account.pk is not None

    with pytest.raises(RuntimeError, match='an account factory creates one account'):
        account.services.factory.create(
            email='morgan@example.com',
            name='Morgan',
            promo_code='',
            region='CA-AB',
        )

    assert Account.objects.count() == 1
    assert Account.objects.get().email == 'avery@example.com'


def test_account_saved_as_an_update_is_refused_and_rolled_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    save_original = AccountFactoryService.save_model_obj
    save_reported_as_update = partialmethod(_save_reported_as_update, save=save_original)

    monkeypatch.setattr(AccountFactoryService, 'save_model_obj', save_reported_as_update)

    with pytest.raises(RuntimeError, match='was updated instead of created'):
        Account.services.factory.create(
            email='avery@example.com',
            name='Avery',
            promo_code='',
            region='CA-AB',
        )

    assert Account.objects.count() == 0


def test_account_create_refuses_a_promo_over_the_limit_before_touching_the_database() -> None:
    with pytest.raises(PromoInvalidError, match='A promo code has at most'):
        Account.services.factory.create(
            email='avery@example.com',
            name='Avery',
            promo_code='P' * (PROMO_CODE_LENGTH_MAX + 1),
            region='CA-AB',
        )

    assert Account.objects.count() == 0
