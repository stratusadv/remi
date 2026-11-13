from types import MappingProxyType

from app.funnel.choices import CampaignChoices


FUNNEL_PAGE_ORIGIN = 'https://remirememberthat.com'
FUNNEL_PAGE_URL_GENERAL = f'{FUNNEL_PAGE_ORIGIN}/'
FUNNEL_PAGE_URL_WIB = f'{FUNNEL_PAGE_ORIGIN}/wib/'
FUNNEL_PAGE_URL_WIB_DOWNLOAD = f'{FUNNEL_PAGE_URL_WIB}download/'
FUNNEL_PATH_PREFIX = '/api/v1/funnel/'
FUNNEL_PROMO_CODES_SHARED = MappingProxyType({CampaignChoices.WIB: 'WIB2026'})
