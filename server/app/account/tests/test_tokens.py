from __future__ import annotations

import hashlib
import re
import secrets

import pytest

from types import SimpleNamespace

from app.account import tokens
from app.account.constants import ACCOUNT_TOKEN_HASH_LENGTH, ACCOUNT_TOKEN_LENGTH_MAX
from app.account.tokens import token_generate, token_hash


TOKEN_PATTERN = re.compile(r'[A-Za-z0-9_-]{43}')
TOKEN_SAMPLES = 200


class DigestShort:
    def hexdigest(self) -> str:
        return 'abc123'


def _digest_short(data: bytes) -> DigestShort:
    assert isinstance(data, bytes)
    assert data

    return DigestShort()


def test_tokens_are_url_safe_distinct_and_stored_as_their_sha256_digest() -> None:
    generated = [token_generate() for _ in range(TOKEN_SAMPLES)]

    for token in generated:
        digest = hashlib.sha256(token.encode()).hexdigest()

        assert TOKEN_PATTERN.fullmatch(token) is not None, token
        assert token_hash(token) == digest
        assert len(token_hash(token)) == ACCOUNT_TOKEN_HASH_LENGTH

    assert len(set(generated)) == TOKEN_SAMPLES


def test_token_hash_accepts_one_to_the_maximum_characters_and_refuses_the_rest() -> None:
    longest = 'k' * ACCOUNT_TOKEN_LENGTH_MAX
    overlong = 'k' * (ACCOUNT_TOKEN_LENGTH_MAX + 1)

    assert len(token_hash('k')) == ACCOUNT_TOKEN_HASH_LENGTH
    assert len(token_hash(longest)) == ACCOUNT_TOKEN_HASH_LENGTH
    assert token_hash(longest) == hashlib.sha256(longest.encode()).hexdigest()

    for refused in ('', overlong):
        with pytest.raises(ValueError, match=f'token must be 1 to {ACCOUNT_TOKEN_LENGTH_MAX}'):
            token_hash(refused)


def test_token_generator_that_returns_an_empty_token_is_a_programming_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    longest = 'k' * ACCOUNT_TOKEN_LENGTH_MAX

    monkeypatch.setattr(secrets, 'token_urlsafe', lambda _: 'k')

    assert token_generate() == 'k'

    monkeypatch.setattr(secrets, 'token_urlsafe', lambda _: longest)

    assert token_generate() == longest

    monkeypatch.setattr(secrets, 'token_urlsafe', lambda _: '')

    with pytest.raises(RuntimeError, match='a generated token has 0 characters'):
        token_generate()


def test_token_digest_of_the_wrong_length_is_a_programming_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hashlib_short = SimpleNamespace(sha256=_digest_short)

    assert token_hash('avery') == hashlib.sha256(b'avery').hexdigest()

    monkeypatch.setattr(tokens, 'hashlib', hashlib_short)

    with pytest.raises(RuntimeError, match='a token hash has 6 characters'):
        token_hash('avery')
