from django.db.models import TextChoices


class AccountLedgerEntryKindChoices(TextChoices):
    CHARGE = 'charge', 'Charge'
    GRANT = 'grant', 'Grant'
    PROMO = 'promo', 'Promo'
    PURCHASE = 'purchase', 'Purchase'
    REINSTATEMENT = 'reinstatement', 'Reinstatement'
    REVERSAL = 'reversal', 'Reversal'


ACCOUNT_LEDGER_ENTRY_KINDS_DEBIT = (
    AccountLedgerEntryKindChoices.CHARGE,
    AccountLedgerEntryKindChoices.REVERSAL,
)

ACCOUNT_LEDGER_ENTRY_KINDS_PAYMENT = (
    AccountLedgerEntryKindChoices.PURCHASE,
    AccountLedgerEntryKindChoices.REINSTATEMENT,
    AccountLedgerEntryKindChoices.REVERSAL,
)

ACCOUNT_LEDGER_ENTRY_KINDS_ZERO = (
    AccountLedgerEntryKindChoices.REINSTATEMENT,
    AccountLedgerEntryKindChoices.REVERSAL,
)
