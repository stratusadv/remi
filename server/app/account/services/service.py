from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django_spire.contrib.constructor.service import BaseDjangoModelService

from app.account.services.checkout_service import AccountCheckoutService
from app.account.services.factory_service import AccountFactoryService
from app.account.services.processor_service import AccountProcessorService

if TYPE_CHECKING:
    from app.account.models import Account


class AccountService(BaseDjangoModelService['Account']):
    obj: Account

    checkout = AccountCheckoutService()
    factory = AccountFactoryService()
    processor = AccountProcessorService()
