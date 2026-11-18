from __future__ import annotations

import pytest

from typing_extensions import TYPE_CHECKING

from app.account.models import Account
from app.account.tests.factories import create_test_account
from app.core.exceptions import RequestInvalidError

if TYPE_CHECKING:
    from harness.stripe import StripeFake


pytestmark = pytest.mark.django_db
RETURN_URL = 'https://api.example.test/checkout/return/'


def test_session_create_needs_an_offered_pack_an_absolute_return_url_and_a_saved_account(
    stripe_fake: StripeFake,
) -> None:
    account = create_test_account()
    unsaved = Account(email='unsaved@example.com', name='Unsaved')
    checkout = account.services.checkout

    with pytest.raises(RequestInvalidError, match='no longer on offer'):
        checkout.session_create(hours=49, return_url=RETURN_URL)

    for return_url in ('/checkout/return/', 'ftp://api.example.test/', 'remi://checkout'):
        with pytest.raises(ValueError, match='return_url must be an absolute http or https URL'):
            checkout.session_create(hours=50, return_url=return_url)

    with pytest.raises(ValueError, match='the account must be saved'):
        unsaved.services.checkout.session_create(hours=50, return_url=RETURN_URL)

    assert unsaved.pk is None
    assert stripe_fake.created == []


def test_session_finish_needs_a_saved_account(stripe_fake: StripeFake) -> None:
    unsaved = Account(email='unsaved@example.com', name='Unsaved')

    with pytest.raises(ValueError, match='the account must be saved'):
        unsaved.services.checkout.session_finish('cs_test_1')

    assert unsaved.pk is None
    assert stripe_fake.sessions == {}


def test_session_create_accepts_a_plain_http_return_url_for_a_local_server(
    stripe_fake: StripeFake,
) -> None:
    account = create_test_account()
    session = account.services.checkout.session_create(
        hours=50,
        return_url='http://127.0.0.1:8001/checkout/return/',
    )

    assert session.id == 'cs_test_1'
    assert stripe_fake.created[0]['return_url'] == 'http://127.0.0.1:8001/checkout/return/'
