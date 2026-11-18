from django.db.models import TextChoices


class CampaignChoices(TextChoices):
    GENERAL = 'general', 'General'
    WIB = 'wib', 'Women in Business'


class FunnelPageChoices(TextChoices):
    LANDING = 'landing', 'Landing page'
    PROMO = 'promo', 'Promo page'


class FunnelPlatformChoices(TextChoices):
    LINUX = 'linux', 'Linux'
    MACOS = 'macos', 'macOS'
    WINDOWS = 'windows', 'Windows'
