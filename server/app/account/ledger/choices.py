from django.db.models import TextChoices


class AccountLedgerEntryKindChoices(TextChoices):
    CHARGE = 'charge', 'Charge'
    PROMO = 'promo', 'Promo'
    PURCHASE = 'purchase', 'Purchase'
