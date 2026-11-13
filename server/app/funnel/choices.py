from django.db.models import TextChoices


class CampaignChoices(TextChoices):
    GENERAL = 'general', 'General'
    WIB = 'wib', 'Women in Business'


class FunnelPlatformChoices(TextChoices):
    LINUX = 'linux', 'Linux'
    MACOS = 'macos', 'macOS'
    WINDOWS = 'windows', 'Windows'


class FunnelSourceChoices(TextChoices):
    LINK = 'link', 'Link'
    QR_CODE = 'qr', 'QR code'
