from django.db.models import TextChoices


class AccountLedgerEntryKindChoices(TextChoices):
    CHARGE = 'charge', 'Charge'
    GRANT = 'grant', 'Grant'
    PROMO = 'promo', 'Promo'
    PURCHASE = 'purchase', 'Purchase'
