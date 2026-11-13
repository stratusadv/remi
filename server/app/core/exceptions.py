class BillingError(Exception):
    code = 'billing_error'
    status = 500


class RefusalError(BillingError):
    code = 'request_refused'
    status = 400


class UnavailableError(BillingError):
    code = 'service_unavailable'
    status = 503


class BalanceInsufficientError(RefusalError):
    code = 'balance_insufficient'
    status = 402


class CheckoutUnknownError(RefusalError):
    code = 'checkout_unknown'
    status = 404


class PromoInvalidError(RefusalError):
    code = 'promo_invalid'
    status = 400


class RequestInvalidError(RefusalError):
    code = 'request_invalid'
    status = 400


class PaymentsUnavailableError(UnavailableError):
    code = 'payments_unavailable'
    status = 503
