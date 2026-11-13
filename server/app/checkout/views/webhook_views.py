from __future__ import annotations

from django.http import HttpRequest, HttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from app.account.ledger.models import AccountLedgerEntry
from app.core.exceptions import BillingError


STATUS_OK = 200


@csrf_exempt
@require_http_methods(['POST'])
def stripe_event_view(request: HttpRequest) -> HttpResponse:
    try:
        AccountLedgerEntry.services.factory.purchase_from_event(
            payload=request.body,
            signature=request.headers.get('Stripe-Signature', ''),
        )
    except BillingError as error:
        return HttpResponse(str(error), status=error.status)

    return HttpResponse(status=STATUS_OK)
