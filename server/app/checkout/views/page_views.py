from __future__ import annotations

from django.http import HttpRequest, HttpResponse
from django.views.decorators.http import require_http_methods


RETURN_MESSAGE = 'Payment received. Close this window and open remi again to see your hours.'


@require_http_methods(['GET'])
def checkout_return_view(request: HttpRequest) -> HttpResponse:
    _ = request

    return HttpResponse(RETURN_MESSAGE, content_type='text/plain; charset=utf-8')
