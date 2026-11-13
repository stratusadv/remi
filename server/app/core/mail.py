from __future__ import annotations

from sendgrid_backend.mail import SendgridBackend


SENDGRID_TIMEOUT_SECONDS = 10


class SendgridTimeoutBackend(SendgridBackend):
    def __init__(self, *arguments: object, **keyword_arguments: object) -> None:
        super().__init__(*arguments, **keyword_arguments)

        self.sg.client.timeout = SENDGRID_TIMEOUT_SECONDS
