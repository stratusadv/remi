from __future__ import annotations

import ipaddress

from typing_extensions import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable

    from django.http import HttpRequest, HttpResponse


REMOTE_ADDRESS_HEADER = 'HTTP_DO_CONNECTING_IP'


class RemoteAddressMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        header = request.META.get(REMOTE_ADDRESS_HEADER, '')

        try:
            address = ipaddress.ip_address(header.strip())
        except ValueError:
            return self.get_response(request)

        request.META['REMOTE_ADDR'] = str(address)

        return self.get_response(request)
