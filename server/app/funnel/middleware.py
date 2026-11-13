from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from app.funnel.constants import FUNNEL_PAGE_ORIGIN, FUNNEL_PATH_PREFIX

if TYPE_CHECKING:
    from collections.abc import Callable

    from django.http import HttpRequest, HttpResponse


class FunnelCorsMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        response = self.get_response(request)

        if request.path.startswith(FUNNEL_PATH_PREFIX):
            response['Access-Control-Allow-Origin'] = FUNNEL_PAGE_ORIGIN

        return response
