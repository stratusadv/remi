from __future__ import annotations

from typing_extensions import TYPE_CHECKING, Self

from app.core.querysets import BaseQuerySet
from app.promo_code.constants import PROMO_CODE_LENGTH_MAX

if TYPE_CHECKING:
    from app.promo_code.models import PromoCode


class PromoCodeQuerySet(BaseQuerySet['PromoCode']):
    def by_code(self, code: str) -> Self:
        if not 0 < len(code) <= PROMO_CODE_LENGTH_MAX:
            message = f'code must be 1 to {PROMO_CODE_LENGTH_MAX} characters: {code!r}'
            raise ValueError(message)

        return self.filter(code__iexact=code)
