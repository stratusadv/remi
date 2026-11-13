import hashlib
import secrets

from app.account.constants import (
    ACCOUNT_TOKEN_BYTES,
    ACCOUNT_TOKEN_HASH_LENGTH,
    ACCOUNT_TOKEN_LENGTH_MAX,
)


def token_generate() -> str:
    token = secrets.token_urlsafe(ACCOUNT_TOKEN_BYTES)

    if not 0 < len(token) <= ACCOUNT_TOKEN_LENGTH_MAX:
        message = f'a generated token has {len(token)} characters'
        raise RuntimeError(message)

    return token


def token_hash(token: str) -> str:
    if not 0 < len(token) <= ACCOUNT_TOKEN_LENGTH_MAX:
        message = f'token must be 1 to {ACCOUNT_TOKEN_LENGTH_MAX} characters: {len(token)}'
        raise ValueError(message)

    digest = hashlib.sha256(token.encode()).hexdigest()

    if len(digest) != ACCOUNT_TOKEN_HASH_LENGTH:
        message = f'a token hash has {len(digest)} characters'
        raise RuntimeError(message)

    return digest
