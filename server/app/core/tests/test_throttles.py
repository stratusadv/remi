from __future__ import annotations

import re
import threading

import pytest

from typing_extensions import TYPE_CHECKING, cast

from django.test import RequestFactory

from app.account.models import Account
from app.core.throttles import AccountRateThrottle, AddressRateThrottle

if TYPE_CHECKING:
    from django.http import HttpRequest

    from app.api.auth import AccountRequest


CALLS_PER_THREAD = 40
LIMIT = 100
RATE_PATTERN = re.compile(r'[1-9][0-9]*/[dhms]')
THREAD_COUNT = 8
THREAD_WAIT_SECONDS = 30.0


def _request(*, account_pk: int | None, address: str = '203.0.113.7') -> HttpRequest:
    assert account_pk is None or account_pk > 0
    assert address.count('.') == 3

    request = RequestFactory().post('/', REMOTE_ADDR=address)

    if account_pk is None:
        return request

    accounted = cast('AccountRequest', request)
    accounted.auth = Account(pk=account_pk, email=f'person{account_pk}@example.com', name='Avery')

    return accounted


def _calls_run(throttle: AccountRateThrottle, allowed: dict[int, int], index: int) -> None:
    assert throttle.limit == LIMIT
    assert allowed == {}
    assert index >= 0

    for call in range(CALLS_PER_THREAD):
        account_pk = 1 + (index + call) % 2
        request = _request(account_pk=account_pk)

        if throttle.allow_request(request):
            allowed[account_pk] = allowed.get(account_pk, 0) + 1


def test_racing_threads_never_count_a_request_against_the_wrong_account() -> None:
    throttle = AccountRateThrottle(f'{LIMIT}/m', scope='race')
    tallies: list[dict[int, int]] = [{} for _ in range(THREAD_COUNT)]

    threads = [
        threading.Thread(target=_calls_run, args=(throttle, tallies[index], index))
        for index in range(THREAD_COUNT)
    ]

    for thread in threads:
        thread.start()

    for thread in threads:
        thread.join(timeout=THREAD_WAIT_SECONDS)

    calls_per_account = THREAD_COUNT * CALLS_PER_THREAD // 2
    allowed = {pk: sum(tally.get(pk, 0) for tally in tallies) for pk in (1, 2)}

    assert calls_per_account > LIMIT
    assert allowed == {1: LIMIT, 2: LIMIT}


def test_a_throttled_account_waits_and_another_account_does_not() -> None:
    throttle = AccountRateThrottle('2/m', scope='wait')
    first = [throttle.allow_request(_request(account_pk=1)) for _ in range(3)]
    wait = throttle.wait()
    other = throttle.allow_request(_request(account_pk=2))

    assert first == [True, True, False]
    assert wait is not None
    assert 0 < wait <= 60
    assert other


def test_each_throttle_counts_only_its_own_kind_of_caller() -> None:
    account = AccountRateThrottle('1/m', scope='kind_account')
    address = AddressRateThrottle('1/m', scope='kind_address')

    for _ in range(3):
        assert account.allow_request(_request(account_pk=None))
        assert address.allow_request(_request(account_pk=7))

    assert account.allow_request(_request(account_pk=7))
    assert not account.allow_request(_request(account_pk=7))
    assert address.allow_request(_request(account_pk=None))
    assert not address.allow_request(_request(account_pk=None))
    assert address.allow_request(_request(account_pk=None, address='198.51.100.4'))


@pytest.mark.parametrize('rate', ['', '0/m', 'ten/m', '10/w', '10'])
def test_a_rate_that_allows_nothing_or_names_no_period_is_refused(rate: str) -> None:
    assert RATE_PATTERN.fullmatch(rate) is None

    with pytest.raises(ValueError, match='rate'):
        AccountRateThrottle(rate, scope='refused')
