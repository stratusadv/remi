from __future__ import annotations

from typing_extensions import TYPE_CHECKING, Self

from ninja import Schema
from pydantic import ConfigDict, ModelWrapValidatorHandler, model_validator
from pydantic_core import PydanticCustomError

from django.conf import settings

from app.checkout import client

if TYPE_CHECKING:
    from app.account.models import Account


BODY_OBJECT_ERROR = 'body_object'
BODY_OBJECT_MESSAGE = 'a request body is a JSON object, not {kind}'


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


class AccountChargeSchema(RequestBodySchema):
    job_id: str
    seconds: int


class AccountCreateSchema(RequestBodySchema):
    email: str
    name: str
    promo_code: str


class AccountOfferSchema(Schema):
    currency: str
    hours: int
    price_cents: int


class AccountPromoSchema(RequestBodySchema):
    code: str


class AccountSchema(Schema):
    balance_seconds: int
    email: str
    name: str
    offers: list[AccountOfferSchema]
    payments: bool
    publishable_key: str

    @staticmethod
    def resolve_balance_seconds(account: Account) -> int:
        if account.pk is None:
            message = f'account must be saved: {account!r}'
            raise ValueError(message)

        return account.ledger_entries.balance_seconds()

    @staticmethod
    def resolve_offers(account: Account) -> list[AccountOfferSchema]:
        if account.pk is None:
            message = f'account must be saved: {account!r}'
            raise ValueError(message)

        currency = settings.REMI_PRICE_CURRENCY

        return [
            AccountOfferSchema(currency=currency, hours=hours, price_cents=price_cents)
            for hours, price_cents in settings.REMI_OFFERS.items()
        ]

    @staticmethod
    def resolve_payments(account: Account) -> bool:
        if account.pk is None:
            message = f'account must be saved: {account!r}'
            raise ValueError(message)

        return client.payments_configured()

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
