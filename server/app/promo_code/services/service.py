from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from django_spire.contrib.constructor.service import BaseDjangoModelService

from app.promo_code.services.processor_service import PromoCodeProcessorService

if TYPE_CHECKING:
    from app.promo_code.models import PromoCode


class PromoCodeService(BaseDjangoModelService['PromoCode']):
    obj: PromoCode

    processor = PromoCodeProcessorService()
