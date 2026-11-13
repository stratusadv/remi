from ninja import Form, Router, Status
from ninja.throttling import AnonRateThrottle

from django.http import HttpRequest

from app.api.v1.funnel.schemas import FunnelDownloadSchema, FunnelEmailSchema, FunnelVisitSchema
from app.funnel.mail import funnel_email_send
from app.funnel.metric import funnel_download_record, funnel_visit_record
from app.funnel.promo import funnel_promo_downloaded


STATUS_NO_CONTENT = 204
THROTTLE_RATE_BEACON = '600/m'
THROTTLE_RATE_EMAIL = '30/m'


class FunnelBeaconThrottle(AnonRateThrottle):
    scope = 'funnel_beacon'


class FunnelEmailThrottle(AnonRateThrottle):
    scope = 'funnel_email'


router = Router(tags=['funnel'], throttle=[FunnelBeaconThrottle(THROTTLE_RATE_BEACON)])


@router.post('/download/', auth=None, response={STATUS_NO_CONTENT: None})
def funnel_download(request: HttpRequest, payload: Form[FunnelDownloadSchema]) -> Status:
    if not isinstance(payload, FunnelDownloadSchema):
        message = f'payload must be a FunnelDownloadSchema: {type(payload).__name__}'
        raise TypeError(message)

    _ = request

    funnel_download_record(campaign=payload.campaign, platform=payload.platform)

    if payload.code != '':
        funnel_promo_downloaded(payload.code)

    return Status(STATUS_NO_CONTENT, None)


@router.post(
    '/email/',
    auth=None,
    response={STATUS_NO_CONTENT: None},
    throttle=FunnelEmailThrottle(THROTTLE_RATE_EMAIL),
)
def funnel_email(request: HttpRequest, payload: Form[FunnelEmailSchema]) -> Status:
    if not isinstance(payload, FunnelEmailSchema):
        message = f'payload must be a FunnelEmailSchema: {type(payload).__name__}'
        raise TypeError(message)

    _ = request

    funnel_email_send(address=payload.email, campaign=payload.campaign)

    return Status(STATUS_NO_CONTENT, None)


@router.post('/visit/', auth=None, response={STATUS_NO_CONTENT: None})
def funnel_visit(request: HttpRequest, payload: Form[FunnelVisitSchema]) -> Status:
    if not isinstance(payload, FunnelVisitSchema):
        message = f'payload must be a FunnelVisitSchema: {type(payload).__name__}'
        raise TypeError(message)

    _ = request

    funnel_visit_record(campaign=payload.campaign, source=payload.source)

    return Status(STATUS_NO_CONTENT, None)
