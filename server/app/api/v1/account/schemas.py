from __future__ import annotations

from typing_extensions import TYPE_CHECKING, Self

from ninja import Schema
from pydantic import ConfigDict, ModelWrapValidatorHandler, model_validator
from pydantic_core import PydanticCustomError

from django.conf import settings

from app.account.constants import CHECKOUT_HOURS_MAX
from app.checkout import client

if TYPE_CHECKING:
    from app.account.models import Account


BODY_OBJECT_ERROR = 'body_object'
BODY_OBJECT_MESSAGE = 'a request body is a JSON object, not {kind}'
OFFER_HOURS = (10, 50, 200)


class RequestBodySchema(Schema):
    model_config = ConfigDict(strict=True)

    @model_validator(mode='wrap')
    @classmethod
    def _body_object_require(
        cls,
        data: object,
        handler: ModelWrapValidatorHandler[Self],
    ) -> Self:
        if not isinstance(data, dict):
            context = {'kind': type(data).__name__}
            raise PydanticCustomError(BODY_OBJECT_ERROR, BODY_OBJECT_MESSAGE, context)

        return handler(data)


class AccountActionSchema(RequestBodySchema):
    action: str


class AccountChargeSchema(RequestBodySchema):
    job_id: str
    seconds: int


class AccountCreateSchema(RequestBodySchema):
    email: str
    name: str
    promo_code: str
    region: str


class AccountOfferSchema(Schema):
    currency: str
    hours: int
    price_cents: int


class AccountPromoSchema(RequestBodySchema):
    code: str


class AccountSchema(Schema):
    balance_seconds: int
    checkout_hours_max: int
    email: str
    name: str
    offers: list[AccountOfferSchema]
    payments: bool
    price_currency: str
    price_hour_cents: int
    publishable_key: str

    @staticmethod
    def resolve_balance_seconds(account: Account) -> int:
        if account.pk is None:
            message = f'account must be saved: {account!r}'
            raise ValueError(message)

        return account.ledger_entries.balance_seconds()

    @staticmethod
    def resolve_checkout_hours_max(account: Account) -> int:
        if account.pk is None:
            message = f'account must be saved: {account!r}'
            raise ValueError(message)

        return CHECKOUT_HOURS_MAX

    @staticmethod
    def resolve_offers(account: Account) -> list[AccountOfferSchema]:
        if account.pk is None:
            message = f'account must be saved: {account!r}'
            raise ValueError(message)

        currency = settings.REMI_PRICE_CURRENCY
        price_hour_cents = settings.REMI_PRICE_HOUR_CENTS

        return [
            AccountOfferSchema(currency=currency, hours=hours, price_cents=hours * price_hour_cents)
            for hours in OFFER_HOURS
        ]

    @staticmethod
    def resolve_payments(account: Account) -> bool:
        if account.pk is None:
            message = f'account must be saved: {account!r}'
            raise ValueError(message)

        return client.payments_configured()

    @staticmethod
    def resolve_price_currency(account: Account) -> str:
        if account.pk is None:
            message = f'account must be saved: {account!r}'
            raise ValueError(message)

        return settings.REMI_PRICE_CURRENCY

    @staticmethod
    def resolve_price_hour_cents(account: Account) -> int:
        if account.pk is None:
            message = f'account must be saved: {account!r}'
            raise ValueError(message)

        return settings.REMI_PRICE_HOUR_CENTS

    @staticmethod
    def resolve_publishable_key(account: Account) -> str:
        if account.pk is None:
            message = f'account must be saved: {account!r}'
            raise ValueError(message)

        if not client.payments_configured():
            return ''

        return client.publishable_key()


class AccountCreatedSchema(Schema):
    account: AccountSchema
    token: str


class CheckoutFinishSchema(RequestBodySchema):
    session_id: str


class CheckoutFinishedSchema(Schema):
    account: AccountSchema
    paid: bool


class CheckoutSchema(Schema):
    client_secret: str
    session_id: str


class CheckoutStartSchema(RequestBodySchema):
    hours: int


class QuestionFinishedSchema(Schema):
    question_id: int
    tokens: int


class QuestionFinishSchema(RequestBodySchema):
    question_id: int
    tokens: int


class QuestionStartedSchema(Schema):
    notice: str
    question_id: int | None
    wait_seconds: int
