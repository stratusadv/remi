from __future__ import annotations

import ipaddress
import logging
import time

from typing_extensions import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable

    from django.http import HttpRequest, HttpResponse


NANOSECONDS_PER_MILLISECOND = 1_000_000
REMOTE_ADDRESS_HEADER = 'HTTP_DO_CONNECTING_IP'
logger = logging.getLogger(__name__)


class RemoteAddressMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        try:
            header = request.META.get(REMOTE_ADDRESS_HEADER, '')
            address = ipaddress.ip_address(header.strip())
        except ValueError:
            return self.get_response(request)

        request.META['REMOTE_ADDR'] = str(address)
        return self.get_response(request)


class RequestLogMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        started_ns = time.monotonic_ns()
        response = self.get_response(request)
        duration_ms = (time.monotonic_ns() - started_ns) // NANOSECONDS_PER_MILLISECOND
        account = getattr(request, 'auth', None)
        account_id = getattr(account, 'pk', None)

        logger.info(
            '%s %s %s in %s ms for account %s',
            request.method,
            request.path,
            response.status_code,
            duration_ms,
            account_id,
        )

        return response
