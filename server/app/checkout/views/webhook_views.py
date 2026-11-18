from __future__ import annotations

import logging

from django.http import HttpRequest, HttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from app.account.ledger.models import AccountLedgerEntry
from app.core.exceptions import BillingError


logger = logging.getLogger(__name__)

STATUS_OK = 200


@csrf_exempt
@require_http_methods(['POST'])
def stripe_event_view(request: HttpRequest) -> HttpResponse:
    try:
        AccountLedgerEntry.services.factory.event_apply(
            payload=request.body,
            signature=request.headers.get('Stripe-Signature', ''),
        )
    except BillingError as error:
        logger.warning('a Stripe event was refused with %s: %s', error.status, error)

        return HttpResponse(str(error), status=error.status)

    return HttpResponse(status=STATUS_OK)
