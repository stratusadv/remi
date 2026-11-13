from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django_spire.contrib.constructor.service import BaseDjangoModelService

from app.account.ledger.services.factory_service import AccountLedgerEntryFactoryService

if TYPE_CHECKING:
    from app.account.ledger.models import AccountLedgerEntry


class AccountLedgerEntryService(BaseDjangoModelService['AccountLedgerEntry']):
    obj: AccountLedgerEntry

    factory = AccountLedgerEntryFactoryService()
