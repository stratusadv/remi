from __future__ import annotations

import json

import pytest

from typing_extensions import TYPE_CHECKING, Any, cast

from ninja.errors import AuthenticationError, HttpError, Throttled, ValidationError

from django.test import RequestFactory

from app.account.constants import SECONDS_PER_HOUR
from app.account.models import Account
from app.account.tests.factories import create_test_account
from app.api.auth import AccountBearerAuth
from app.api.v1 import api
from app.api.v1.account import router as account_router
from app.api.v1.account.schemas import AccountActionSchema, AccountCreateSchema, AccountSchema
from app.api.v1.funnel import router as funnel_router
from app.api.v1.funnel.schemas import FunnelClickSchema, FunnelDownloadSchema, FunnelEmailSchema
from app.core.exceptions import EmailUnavailableError
from app.funnel.choices import CampaignChoices, FunnelPageChoices, FunnelPlatformChoices
from harness.fixtures import PRICE_CURRENCY, PRICE_HOUR_CENTS
from harness.stripe import STRIPE_PUBLISHABLE_KEY

if TYPE_CHECKING:
    from django.http import HttpRequest, HttpResponse

    from app.api.auth import AccountRequest


pytestmark = pytest.mark.django_db
MESSAGE_BODY_OBJECT = 'The request body must be a JSON object.'


def _envelope(response: HttpResponse) -> dict[str, object]:
    assert 400 <= response.status_code <= 599
    assert response['Content-Type'].startswith('application/json')

    return json.loads(response.content)


def _request() -> HttpRequest:
    return RequestFactory().post('/api/v1/account/')


def _request_unsaved() -> AccountRequest:
    request = cast('AccountRequest', _request())
    request.auth = Account(email='unsaved@example.com', name='Unsaved')

    assert request.auth.pk is None

    return request


def test_error_response_refuses_a_blank_code_or_message_or_a_status_that_is_not_an_error() -> None:
    request = _request()
    accepted = api.error_response(request, code='gone', message='Gone.', status=404)
    error = {'code': 'gone', 'message': 'Gone.', 'type': 'billing_error'}

    assert accepted.status_code == 404
    assert _envelope(accepted) == {'error': error}

    with pytest.raises(ValueError, match='code must be non-empty'):
        api.error_response(request, code='', message='Gone.', status=404)

    with pytest.raises(ValueError, match='the gone error must carry a message'):
        api.error_response(request, code='gone', message='', status=404)

    for status in (200, 399, 600):
        with pytest.raises(ValueError, match=f'status must be an error status: {status}'):
            api.error_response(request, code='gone', message='Gone.', status=status)


def test_error_response_wraps_the_code_and_message_in_the_billing_envelope() -> None:
    for status in (400, 599):
        response = api.error_response(_request(), code='gone', message='Gone.', status=status)
        error = {'code': 'gone', 'message': 'Gone.', 'type': 'billing_error'}

        assert response.status_code == status
        assert _envelope(response) == {'error': error}


def test_validation_message_names_the_last_field_of_the_first_error() -> None:
    examples: list[tuple[list[dict[str, object]], str]] = [
        ([{'loc': ('body', 'payload', 'email'), 'type': 'missing'}], 'The request has no email.'),
        (
            [{'loc': ('body', 'payload', 'seconds'), 'type': 'int_type'}],
            'The request needs a valid seconds.',
        ),
        (
            [{'loc': ('body', 'payload', 'offers', 0, 'hours'), 'type': 'int_type'}],
            'The request needs a valid hours.',
        ),
        (
            [{'loc': ('form', 'campaign'), 'type': 'enum'}, {'loc': ('form', 'source')}],
            'The request needs a valid campaign.',
        ),
        ([{'loc': ('body', 'payload'), 'type': 'body_object'}], MESSAGE_BODY_OBJECT),
        ([{'type': 'missing'}], MESSAGE_BODY_OBJECT),
        ([{'loc': ('query', 0), 'type': 'missing'}], MESSAGE_BODY_OBJECT),
    ]

    for errors, expected in examples:
        assert api.validation_message(errors) == expected, errors


def test_validation_message_refuses_no_errors_or_a_location_that_is_not_a_tuple() -> None:
    errors: list[dict[str, object]] = [{'loc': ['body', 'payload', 'email'], 'type': 'missing'}]
    errors_accepted = [{**errors[0], 'loc': ('body', 'payload', 'email')}]

    assert api.validation_message(errors_accepted) == 'The request has no email.'

    with pytest.raises(ValueError, match='errors must be non-empty'):
        api.validation_message([])

    with pytest.raises(TypeError, match='carries a location of list'):
        api.validation_message(errors)


def test_http_error_other_than_a_bad_body_is_refused_with_its_own_status() -> None:
    error_missing = HttpError(404, 'That is not here.')
    error_body = HttpError(400, 'Cannot parse request body')
    missing = api.http_error_handle(_request(), error_missing)
    body = api.http_error_handle(_request(), error_body)

    refused = {'code': 'request_refused', 'message': 'That is not here.', 'type': 'billing_error'}
    invalid = {'code': 'request_invalid', 'message': 'The request body is not JSON.'}

    assert missing.status_code == 404
    assert _envelope(missing) == {'error': refused}
    assert body.status_code == 400
    assert _envelope(body) == {'error': {**invalid, 'type': 'billing_error'}}


def test_error_handlers_refuse_an_error_of_another_kind() -> None:
    request = _request()
    error = ValueError('not the expected kind')
    wrong = cast('Any', error)
    validation_errors: list[dict[str, object]] = [{'loc': ('body', 'email'), 'type': 'missing'}]
    error_authentication = AuthenticationError()
    error_billing = EmailUnavailableError('The email did not send.')
    error_throttled = Throttled(60)
    error_validation = ValidationError(validation_errors)

    assert api.authentication_error_handle(request, error_authentication).status_code == 401
    assert api.billing_error_handle(request, error_billing).status_code == 503
    assert api.throttled_handle(request, error_throttled).status_code == 429
    assert api.validation_error_handle(request, error_validation).status_code == 400

    handlers = [
        (api.authentication_error_handle, 'an AuthenticationError'),
        (api.billing_error_handle, 'a BillingError'),
        (api.http_error_handle, 'an HttpError'),
        (api.throttled_handle, 'Throttled'),
        (api.validation_error_handle, 'a ValidationError'),
    ]

    for handler, phrase in handlers:
        with pytest.raises(TypeError, match=f'error must be {phrase}: ValueError'):
            handler(request, wrong)


def test_bearer_authentication_refuses_a_token_that_is_not_text() -> None:
    account, issued = Account.services.factory.create(
        email='avery@example.com',
        name='Avery',
        promo_code='',
        region='CA-AB',
    )

    token = cast('str', 12345)

    assert AccountBearerAuth().authenticate(_request(), issued) == account
    assert AccountBearerAuth().authenticate(_request(), str(token)) is None

    with pytest.raises(TypeError, match='token must be a str: int'):
        AccountBearerAuth().authenticate(_request(), token)


def test_account_views_refuse_a_payload_of_another_schema() -> None:
    request = _request_unsaved()
    payload = cast('Any', {'email': 'avery@example.com'})

    views = [
        (account_router.account_create, 'an AccountCreateSchema'),
        (account_router.account_action, 'an AccountActionSchema'),
        (account_router.account_charge, 'an AccountChargeSchema'),
        (account_router.account_checkout, 'a CheckoutStartSchema'),
        (account_router.account_checkout_finish, 'a CheckoutFinishSchema'),
        (account_router.account_promo, 'an AccountPromoSchema'),
        (account_router.account_question_finish, 'a QuestionFinishSchema'),
    ]

    for view, phrase in views:
        with pytest.raises(TypeError, match=f'payload must be {phrase}: dict'):
            view(request, payload)

    assert not Account.objects.exists()

    schema = AccountCreateSchema(
        email='avery@example.com',
        name='Avery',
        promo_code='',
        region='CA-AB',
    )

    created = account_router.account_create(_request(), schema)

    assert created.status_code == 201


def test_account_views_refuse_an_authenticated_account_that_is_not_saved() -> None:
    request = _request_unsaved()
    saved = create_test_account()
    request_saved = cast('AccountRequest', _request())
    request_saved.auth = saved
    action = AccountActionSchema(action='new-chat')
    acted = account_router.account_action(request_saved, action)

    assert account_router.account_detail(request_saved) == saved
    assert acted.status_code == 204

    with pytest.raises(ValueError, match='the authenticated account must be saved'):
        account_router.account_action(request, action)

    with pytest.raises(ValueError, match='the authenticated account must be saved'):
        account_router.account_detail(request)

    with pytest.raises(ValueError, match='the authenticated account must be saved'):
        account_router.account_question_start(request)

    assert Account.objects.get() == saved


@pytest.mark.usefixtures('stripe_configured')
def test_account_schema_refuses_to_describe_an_unsaved_account() -> None:
    saved = create_test_account(seconds=SECONDS_PER_HOUR)
    offers = AccountSchema.resolve_offers(saved)
    offers_expected = [(hours, hours * PRICE_HOUR_CENTS) for hours in (10, 50, 200)]

    assert AccountSchema.resolve_balance_seconds(saved) == SECONDS_PER_HOUR
    assert AccountSchema.resolve_checkout_hours_max(saved) == 1_000
    assert [(offer.hours, offer.price_cents) for offer in offers] == offers_expected
    assert AccountSchema.resolve_payments(saved)
    assert AccountSchema.resolve_price_currency(saved) == PRICE_CURRENCY
    assert AccountSchema.resolve_price_hour_cents(saved) == PRICE_HOUR_CENTS
    assert AccountSchema.resolve_publishable_key(saved) == STRIPE_PUBLISHABLE_KEY

    unsaved = Account(email='unsaved@example.com', name='Unsaved')

    resolvers = [
        AccountSchema.resolve_balance_seconds,
        AccountSchema.resolve_checkout_hours_max,
        AccountSchema.resolve_offers,
        AccountSchema.resolve_payments,
        AccountSchema.resolve_price_currency,
        AccountSchema.resolve_price_hour_cents,
        AccountSchema.resolve_publishable_key,
    ]

    for resolver in resolvers:
        with pytest.raises(ValueError, match='account must be saved'):
            resolver(unsaved)


def test_funnel_views_refuse_a_payload_of_another_schema() -> None:
    request = _request()
    payload = cast('Any', {'campaign': 'wib'})

    download = FunnelDownloadSchema(
        campaign=CampaignChoices.WIB,
        platform=FunnelPlatformChoices.LINUX,
    )

    click = FunnelClickSchema(campaign=CampaignChoices.WIB, page=FunnelPageChoices.PROMO)
    clicked = funnel_router.funnel_click(request, click)
    downloaded = funnel_router.funnel_download(request, download)

    assert clicked.status_code == 204
    assert downloaded.status_code == 204

    views = [
        (funnel_router.funnel_click, 'a FunnelClickSchema'),
        (funnel_router.funnel_download, 'a FunnelDownloadSchema'),
        (funnel_router.funnel_email, 'a FunnelEmailSchema'),
    ]

    for view, phrase in views:
        with pytest.raises(TypeError, match=f'payload must be {phrase}: dict'):
            view(request, payload)


def test_funnel_schemas_refuse_a_code_or_email_that_is_not_text() -> None:
    number = cast('str', 7)

    assert FunnelDownloadSchema.code_clean(str(number)) == '7'
    assert FunnelEmailSchema.email_clean(f'{number}@example.com') == '7@example.com'

    with pytest.raises(TypeError, match='code must be a str: int'):
        FunnelDownloadSchema.code_clean(number)

    with pytest.raises(TypeError, match='email must be a str: int'):
        FunnelEmailSchema.email_clean(number)


def test_funnel_code_is_trimmed_and_takes_only_letters_digits_and_hyphens() -> None:
    accepted = {' WIB-7KQ4-M2XD ': 'WIB-7KQ4-M2XD', '': '', 'p' * 64: 'p' * 64}
    refused = ['two words', 'WIB_2026', 'p' * 65, 'code;drop', 'café']

    for text, expected in accepted.items():
        assert FunnelDownloadSchema.code_clean(text) == expected

    for text in refused:
        with pytest.raises(ValueError, match='the code is not a promo code'):
            FunnelDownloadSchema.code_clean(text)
