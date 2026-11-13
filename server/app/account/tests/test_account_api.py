from __future__ import annotations

import hashlib

import pytest

from typing_extensions import TYPE_CHECKING

from app.account.constants import SIGNED_OUT_MESSAGE
from app.account.models import Account
from app.funnel.choices import CampaignChoices
from app.promo_code.tests.factories import create_test_promo_code
from harness.api import ACCOUNT_PATH, account_create, account_get, api_post
from harness.fixtures import OFFERS, PRICE_CURRENCY
from harness.stripe import STRIPE_PUBLISHABLE_KEY

if TYPE_CHECKING:
    from django.test import Client


pytestmark = pytest.mark.django_db


def test_account_create_names_the_field_a_request_lacks_or_gets_wrong(client: Client) -> None:
    body_missing = {'email': 'a@example.com', 'name': 'Avery'}
    body_wrong = {'email': 'a@example.com', 'name': 7, 'promo_code': ''}
    body_listed = [1, 2]
    missing = api_post(client, ACCOUNT_PATH, body=body_missing)
    wrong = api_post(client, ACCOUNT_PATH, body=body_wrong)
    listed = api_post(client, ACCOUNT_PATH, body=body_listed)
    empty = client.post(ACCOUNT_PATH, data='', content_type='application/json')
    unparsed = client.post(ACCOUNT_PATH, data='{"email": ', content_type='application/json')

    expected = [
        (missing, 'The request has no promo_code.'),
        (wrong, 'The request needs a valid name.'),
        (listed, 'The request body must be a JSON object.'),
        (empty, 'The request body must be a JSON object.'),
        (unparsed, 'The request body is not JSON.'),
    ]

    for response, message in expected:
        error = {'code': 'request_invalid', 'message': message, 'type': 'billing_error'}

        assert response.status_code == 400, message
        assert response.json() == {'error': error}

    assert Account.objects.count() == 0


def test_account_create_refuses_a_bad_name_email_or_body(client: Client) -> None:
    email_overlong = 'a' * 245 + '@example.com'

    bodies = [
        {'email': 'avery@example.com', 'name': '   ', 'promo_code': ''},
        {'email': 'not-an-email', 'name': 'Avery', 'promo_code': ''},
        {'email': email_overlong, 'name': 'Avery', 'promo_code': ''},
        {'email': 'avery@example.com', 'name': 7, 'promo_code': ''},
        {'email': 'avery@example.com', 'name': 'x' * 400, 'promo_code': ''},
        {'email': 'avery@example.com', 'name': 'Avery'},
        [1, 2],
    ]

    for body in bodies:
        response = api_post(client, ACCOUNT_PATH, body=body)

        assert response.status_code == 400, body
        assert response.json()['error']['code'] == 'request_invalid'

    assert Account.objects.count() == 0


def test_account_create_with_a_campaign_promo_joins_that_campaign(client: Client) -> None:
    create_test_promo_code(campaign=CampaignChoices.WIB, code='WIB2026')
    create_test_promo_code(campaign=CampaignChoices.GENERAL, code='FRIEND')

    account_create(client, promo_code='WIB2026')
    account_create(client, email='morgan@example.com', promo_code='FRIEND')
    account_create(client, email='riley@example.com')

    campaigns = dict(Account.objects.values_list('email', 'campaign'))

    assert campaigns == {
        'avery@example.com': CampaignChoices.WIB,
        'morgan@example.com': CampaignChoices.GENERAL,
        'riley@example.com': CampaignChoices.GENERAL,
    }


def test_account_create_without_a_promo_starts_empty_and_reports_the_offers(
    client: Client,
    stripe_configured: None,
) -> None:
    _ = stripe_configured
    token = account_create(client)
    account = account_get(client, token)
    token_hash = hashlib.sha256(token.encode()).hexdigest()

    offers = [
        {'currency': PRICE_CURRENCY, 'hours': hours, 'price_cents': price_cents}
        for hours, price_cents in sorted(OFFERS)
    ]

    assert account == {
        'balance_seconds': 0,
        'email': 'avery@example.com',
        'name': 'Avery',
        'offers': offers,
        'payments': True,
        'publishable_key': STRIPE_PUBLISHABLE_KEY,
    }

    assert Account.objects.get().token_hash == token_hash


def test_account_detail_refuses_a_request_without_a_valid_token(client: Client) -> None:
    account_create(client)

    headers = [
        {},
        {'Authorization': 'Bearer wrong'},
        {'Authorization': 'Basic abc'},
        {'Authorization': 'Bearer '},
        {'Authorization': 'Bearer ' + 'k' * 300},
    ]

    for header in headers:
        response = client.get(ACCOUNT_PATH, headers=header)
        error = {'code': 'token_invalid', 'message': SIGNED_OUT_MESSAGE, 'type': 'billing_error'}

        assert response.status_code == 401, header
        assert response.json() == {'error': error}


def test_account_detail_refuses_the_token_of_an_inactive_account(client: Client) -> None:
    token = account_create(client)

    Account.objects.get().set_inactive()

    headers = {'Authorization': f'Bearer {token}'}
    response = client.get(ACCOUNT_PATH, headers=headers)

    assert response.status_code == 401
