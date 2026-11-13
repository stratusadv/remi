from __future__ import annotations

import io
import json

from http.client import HTTPMessage
from typing_extensions import TYPE_CHECKING, NamedTuple
from urllib.response import addinfourl

if TYPE_CHECKING:
    from urllib.request import Request


SENDGRID_API_KEY = 'SG.remi-test'
SENDGRID_MESSAGE_ID = 'remi-test-message'
SENDGRID_STATUS_ACCEPTED = 202
SENDGRID_URL = 'https://api.sendgrid.com/v3/mail/send'


class SendgridRequest(NamedTuple):
    authorization: str
    payload: dict[str, object]
    timeout: float | None


class SendgridFake:
    def __init__(self) -> None:
        self.error = None
        self.requests = []

    def open(self, request: Request, timeout: float | None = None) -> addinfourl:
        if request.full_url != SENDGRID_URL:
            message = f'the SendGrid fake answers only {SENDGRID_URL}, not {request.full_url}'
            raise AssertionError(message)

        if not isinstance(request.data, bytes):
            message = f'a SendGrid request carries a JSON body, not {type(request.data).__name__}'
            raise TypeError(message)

        sent = SendgridRequest(
            authorization=request.get_header('Authorization', ''),
            payload=json.loads(request.data),
            timeout=timeout,
        )

        self.requests.append(sent)

        if self.error is not None:
            raise self.error

        body = io.BytesIO(b'')
        headers = HTTPMessage()
        headers['X-Message-Id'] = SENDGRID_MESSAGE_ID

        return addinfourl(body, headers, SENDGRID_URL, SENDGRID_STATUS_ACCEPTED)

    def recipients(self) -> list[str]:
        return [
            recipient['email']
            for request in self.requests
            for personalization in request.payload['personalizations']
            for recipient in personalization['to']
        ]
