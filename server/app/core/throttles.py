from __future__ import annotations

import math
import threading
import time

from types import MappingProxyType
from typing_extensions import TYPE_CHECKING

from ninja.throttling import BaseThrottle

from django.core.cache import cache

if TYPE_CHECKING:
    from django.http import HttpRequest


THROTTLE_LOCK = threading.Lock()
THROTTLE_PERIOD_SECONDS = MappingProxyType({'d': 86_400, 'h': 3_600, 'm': 60, 's': 1})


class LockedRateThrottle(BaseThrottle):
    def __init__(self, rate: str, *, scope: str) -> None:
        if rate.count('/') != 1:
            message = f'rate must read as a count of requests per period: {rate!r}'
            raise ValueError(message)

        count, _, period = rate.partition('/')

        if not count.isdigit():
            message = f'rate must open with a whole number of requests: {rate!r}'
            raise ValueError(message)

        if int(count) <= 0:
            message = f'rate must allow at least one request: {rate!r}'
            raise ValueError(message)

        if period not in THROTTLE_PERIOD_SECONDS:
            message = f'rate must end with one of {sorted(THROTTLE_PERIOD_SECONDS)}: {rate!r}'
            raise ValueError(message)

        if scope == '':
            message = 'scope must be non-empty'
            raise ValueError(message)

        self.limit = int(count)
        self.local = threading.local()
        self.period_seconds = THROTTLE_PERIOD_SECONDS[period]
        self.scope = scope

    def allow_request(self, request: HttpRequest) -> bool:
        ident = self.ident(request)

        if ident is None:
            self.local.history = []
            return True

        now = time.time()

        with THROTTLE_LOCK:
            key = f'throttle_{self.scope}_{ident}'
            window_start = now - self.period_seconds
            history = [moment for moment in cache.get(key, []) if moment > window_start]
            allowed = len(history) < self.limit

            if allowed:
                history.insert(0, now)
                cache.set(key, history, self.period_seconds)

        self.local.history = history
        self.local.now = now

        return allowed

    def ident(self, request: HttpRequest) -> str | None:
        _ = request

        message = f'{type(self).__name__} must name whom a request counts against'
        raise NotImplementedError(message)

    def wait(self) -> float | None:
        history = getattr(self.local, 'history', [])
        now = getattr(self.local, 'now', time.time())
        available = self.limit - len(history) + 1

        if available <= 0:
            return None

        if not history:
            return float(self.period_seconds)

        seconds = (self.period_seconds - (now - history[-1])) / available

        if not math.isfinite(seconds):
            message = f'a throttle wait must be a finite number of seconds: {seconds}'
            raise RuntimeError(message)

        return seconds


class AccountRateThrottle(LockedRateThrottle):
    def ident(self, request: HttpRequest) -> str | None:
        account = getattr(request, 'auth', None)

        if account is None:
            return None

        if account.pk is None:
            message = f'the authenticated account must be saved: {account!r}'
            raise ValueError(message)

        return f'account_{account.pk}'


class AddressRateThrottle(LockedRateThrottle):
    def ident(self, request: HttpRequest) -> str | None:
        if getattr(request, 'auth', None) is not None:
            return None

        return f'address_{self.get_ident(request)}'
