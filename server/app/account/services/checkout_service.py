from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from stripe.params.checkout import (
    SessionCreateParams,
    SessionCreateParamsLineItem,
    SessionCreateParamsLineItemPriceData,
    SessionCreateParamsLineItemPriceDataProductData,
)

from django.conf import settings

from django_spire.contrib.constructor.service import BaseDjangoModelService

from app.account.constants import SECONDS_PER_HOUR
from app.checkout import client
from app.core.exceptions import CheckoutUnknownError, RequestInvalidError
from app.funnel.metric import (
    METRIC_REFERENCE_CHECKOUT,
    FunnelStatistic,
    metric_record,
)

if TYPE_CHECKING:
    import stripe

    from app.account.models import Account


OFFER_UNKNOWN_MESSAGE = 'That pack of hours is no longer on offer. Choose another pack.'


class AccountCheckoutService(BaseDjangoModelService['Account']):
    obj: Account

    def session_create(self, *, hours: int, return_url: str) -> stripe.checkout.Session:
        if hours not in settings.REMI_OFFERS:
            raise RequestInvalidError(OFFER_UNKNOWN_MESSAGE)

        if not return_url.startswith(client.CHECKOUT_RETURN_URL_SCHEMES):
            message = f'return_url must be an absolute http or https URL: {return_url!r}'
            raise ValueError(message)

        if self.obj.pk is None:
            message = f'the account must be saved: {self.obj!r}'
            raise ValueError(message)

        price_cents = settings.REMI_OFFERS[hours]
        account_id = str(self.obj.pk)
        product_name = f'remi: {hours} hours of transcription'
        product = SessionCreateParamsLineItemPriceDataProductData(name=product_name)

        price = SessionCreateParamsLineItemPriceData(
            currency=settings.REMI_PRICE_CURRENCY,
            product_data=product,
            unit_amount=price_cents,
        )

        line_item = SessionCreateParamsLineItem(price_data=price, quantity=1)
        line_items = [line_item]
        metadata = {'account_id': account_id, 'seconds': str(hours * SECONDS_PER_HOUR)}
        payment_method_types_allowed = list(client.CHECKOUT_PAYMENT_METHOD_TYPES_ALLOWED)

        parameters = SessionCreateParams(
            allowed_payment_method_types=payment_method_types_allowed,
            client_reference_id=account_id,
            customer_email=self.obj.email,
            line_items=line_items,
            metadata=metadata,
            mode=client.CHECKOUT_MODE,
            return_url=return_url,
            ui_mode=client.CHECKOUT_UI_MODE,
        )

        session = client.checkout_session_create(parameters)

        metric_record(
            self.obj.campaign,
            FunnelStatistic.CHECKOUTS,
            reference=METRIC_REFERENCE_CHECKOUT,
            source_model=self.obj,
        )

        return session

    def session_finish(self, session_id: str) -> bool:
        if self.obj.pk is None:
            message = f'the account must be saved: {self.obj!r}'
            raise ValueError(message)

        if client.CHECKOUT_SESSION_PATTERN.fullmatch(session_id) is None:
            raise CheckoutUnknownError(client.CHECKOUT_SESSION_INVALID_MESSAGE)

        session = client.checkout_session_retrieve(session_id)

        if session.client_reference_id != str(self.obj.pk):
            raise CheckoutUnknownError(client.CHECKOUT_SESSION_UNKNOWN_MESSAGE)

        from app.account.ledger.models import AccountLedgerEntry

        return AccountLedgerEntry.services.factory.purchase_from_checkout(session)
