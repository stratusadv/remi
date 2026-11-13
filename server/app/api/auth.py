from __future__ import annotations

from ninja.security import HttpBearer

from django.http import HttpRequest

from app.account.constants import ACCOUNT_TOKEN_LENGTH_MAX
from app.account.models import Account
from app.account.tokens import token_hash


class AccountRequest(HttpRequest):
    auth: Account


class AccountBearerAuth(HttpBearer):
    def authenticate(self, request: HttpRequest, token: str) -> Account | None:
        if not isinstance(token, str):
            message = f'token must be a str: {type(token).__name__}'
            raise TypeError(message)

        _ = request

        if not 0 < len(token) <= ACCOUNT_TOKEN_LENGTH_MAX:
            return None

        return Account.objects.active().by_token_hash(token_hash(token)).first()
