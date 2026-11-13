from ninja import Form, Router, Status
from ninja.throttling import AnonRateThrottle

from django.http import HttpRequest

from app.api.v1.funnel.schemas import FunnelDownloadSchema, FunnelVisitSchema
from app.funnel.metric import funnel_download_record, funnel_visit_record


STATUS_NO_CONTENT = 204
THROTTLE_RATE_BEACON = '600/m'

router = Router(tags=['funnel'], throttle=[AnonRateThrottle(THROTTLE_RATE_BEACON)])


@router.post('/download/', auth=None, response={STATUS_NO_CONTENT: None})
def funnel_download(request: HttpRequest, payload: Form[FunnelDownloadSchema]) -> Status:
    if not isinstance(payload, FunnelDownloadSchema):
        message = f'payload must be a FunnelDownloadSchema: {type(payload).__name__}'
        raise TypeError(message)

    _ = request

    funnel_download_record(campaign=payload.campaign, platform=payload.platform)

    return Status(STATUS_NO_CONTENT, None)


@router.post('/visit/', auth=None, response={STATUS_NO_CONTENT: None})
def funnel_visit(request: HttpRequest, payload: Form[FunnelVisitSchema]) -> Status:
    if not isinstance(payload, FunnelVisitSchema):
        message = f'payload must be a FunnelVisitSchema: {type(payload).__name__}'
        raise TypeError(message)

    _ = request

    funnel_visit_record(campaign=payload.campaign, source=payload.source)

    return Status(STATUS_NO_CONTENT, None)
