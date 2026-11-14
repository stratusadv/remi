from __future__ import annotations

import logging

from typing_extensions import TYPE_CHECKING

from django.utils import timezone

from django_spire.contrib.constructor.service import BaseDjangoModelService

if TYPE_CHECKING:
    from app.account.models import Account


COMPLIMENTARY_ACCOUNT_COUNT_MAX = 200
logger = logging.getLogger(__name__)


class AccountAutomationService(BaseDjangoModelService['Account']):
    obj: Account

    def complimentary_topup(self) -> int:
        accounts = self.obj_class.objects.complimentary().order_by('pk')
        count = accounts.count()

        if count > COMPLIMENTARY_ACCOUNT_COUNT_MAX:
            message = (
                f'{count} accounts are complimentary, more than the '
                f'{COMPLIMENTARY_ACCOUNT_COUNT_MAX} one run tops up'
            )

            raise RuntimeError(message)

        reference = f'topup:nightly:{timezone.now().isoformat()}'
        topped_count = 0

        for account in accounts[:COMPLIMENTARY_ACCOUNT_COUNT_MAX]:
            if account.services.processor.balance_topup(reference=reference) > 0:
                topped_count += 1

        logger.info('Topped up %s of %s complimentary accounts', topped_count, count)

        return topped_count
