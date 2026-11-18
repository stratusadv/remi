from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django_spire.contrib.constructor.service import BaseDjangoModelService

from app.account.payment.services.factory_service import AccountPaymentFactoryService

if TYPE_CHECKING:
    from app.account.payment.models import AccountPayment


class AccountPaymentService(BaseDjangoModelService['AccountPayment']):
    obj: AccountPayment

    factory = AccountPaymentFactoryService()
