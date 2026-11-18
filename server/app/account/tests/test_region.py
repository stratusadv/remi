from __future__ import annotations

import re

import pytest

from typing_extensions import TYPE_CHECKING

from django.db import IntegrityError, transaction

from app.account.choices import RegionChoices
from app.account.models import Account
from app.account.tests.factories import create_test_account
from harness.api import ACCOUNT_PATH, api_post

if TYPE_CHECKING:
    from django.test import Client


pytestmark = pytest.mark.django_db
REGION_PATTERN_CANADA = re.compile(r'CA-[A-Z]{2}')
REGION_PATTERN_UNITED_STATES = re.compile(r'US-[A-Z]{2}')
REGIONS_OUTSIDE_CANADA = ('US-DC', 'US-NY', 'outside')
REGIONS_UNKNOWN = ('AB', 'ca-ab', 'CA-XX', ' CA-AB', 'CA-AB ', 'Alberta', 'OUTSIDE')


def test_region_choices_list_canada_then_the_united_states_by_name_then_outside() -> None:
    codes = RegionChoices.values
    labels = dict(RegionChoices.choices)
    canada = [code for code in codes if REGION_PATTERN_CANADA.fullmatch(code)]
    united_states = [code for code in codes if REGION_PATTERN_UNITED_STATES.fullmatch(code)]
    canada_labels = [labels[code] for code in canada]
    united_states_labels = [labels[code] for code in united_states]

    spellings = {
        'CA-NL': 'Newfoundland and Labrador',
        'CA-PE': 'Prince Edward Island',
        'CA-QC': 'Quebec',
        'CA-YT': 'Yukon',
        'US-DC': 'District of Columbia',
    }

    assert {code: labels[code] for code in spellings} == spellings
    assert canada_labels == sorted(canada_labels)
    assert united_states_labels == sorted(united_states_labels)
    assert len(canada) == 13
    assert len(united_states) == 51
    assert codes == [*canada, *united_states, RegionChoices.OUTSIDE]
    assert len(set(labels.values())) == len(codes)


def test_account_create_stores_the_region_it_was_given(client: Client) -> None:
    body = {'email': 'avery@example.com', 'name': 'Avery', 'promo_code': '', 'region': 'CA-QC'}
    response = api_post(client, ACCOUNT_PATH, body=body)

    assert response.status_code == 201
    assert Account.objects.get().region == RegionChoices.CANADA_QC


def test_account_create_refuses_a_region_outside_canada_or_unknown(client: Client) -> None:
    message = 'Choose your province or territory.'
    error = {'code': 'request_invalid', 'message': message, 'type': 'billing_error'}

    for region in ('', *REGIONS_OUTSIDE_CANADA, *REGIONS_UNKNOWN):
        body = {'email': 'avery@example.com', 'name': 'Avery', 'promo_code': '', 'region': region}
        response = api_post(client, ACCOUNT_PATH, body=body)

        assert response.status_code == 400, region
        assert response.json() == {'error': error}, region

    assert not Account.objects.exists()


def test_account_create_names_a_region_the_request_lacks_or_gets_wrong(client: Client) -> None:
    body_missing = {'email': 'avery@example.com', 'name': 'Avery', 'promo_code': ''}
    body_wrong = {'email': 'avery@example.com', 'name': 'Avery', 'promo_code': '', 'region': 7}
    missing = api_post(client, ACCOUNT_PATH, body=body_missing)
    wrong = api_post(client, ACCOUNT_PATH, body=body_wrong)

    expected = [
        (missing, 'The request has no region.'),
        (wrong, 'The request needs a valid region.'),
    ]

    for response, message in expected:
        error = {'code': 'request_invalid', 'message': message, 'type': 'billing_error'}

        assert response.status_code == 400, message
        assert response.json() == {'error': error}

    assert not Account.objects.exists()


def test_each_province_and_territory_is_stored_and_read_back() -> None:
    canada = [code for code in RegionChoices.values if REGION_PATTERN_CANADA.fullmatch(code)]

    for index, region in enumerate(canada):
        Account.services.factory.create(
            email=f'person{index}@example.com',
            name='Avery',
            promo_code='',
            region=region,
        )

    stored = sorted(Account.objects.values_list('region', flat=True))

    assert len(canada) == 13
    assert stored == sorted(canada)


def test_an_account_from_before_sign_up_was_limited_to_canada_keeps_its_region() -> None:
    account = create_test_account()
    accounts = Account.objects.filter(pk=account.pk)

    for region in REGIONS_OUTSIDE_CANADA:
        accounts.update(region=region)

        assert accounts.get().region == region


def test_the_database_keeps_a_blank_region_and_refuses_one_the_choices_do_not_offer() -> None:
    account = create_test_account()
    accounts = Account.objects.filter(pk=account.pk)

    for region in REGIONS_UNKNOWN:
        with pytest.raises(IntegrityError, match='account_region_known'), transaction.atomic():
            accounts.update(region=region)

    blank_count = accounts.update(region='')

    assert blank_count == 1
    assert accounts.get().region == ''
