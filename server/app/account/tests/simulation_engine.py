from __future__ import annotations

import itertools
import random
import time

import stripe

from collections import Counter
from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal
from http import HTTPStatus
from typing_extensions import TYPE_CHECKING, Any, NamedTuple
from urllib.parse import urlencode

from pydantic import ValidationError as PydanticValidationError

from django.conf import settings
from django.utils import timezone

from app.account.constants import SECONDS_PER_HOUR, TOPUP_BALANCE_SECONDS
from app.account.ledger.choices import AccountLedgerEntryKindChoices
from app.account.ledger.models import AccountLedgerEntry
from app.account.models import Account
from app.account.payment.models import AccountPayment
from app.account.question.models import AccountQuestion
from app.account.tests.simulation_model import (
    CHECKOUT_HOURS_MAX,
    JOB_ID_PATTERN,
    PROMO_CODE_LENGTH_MAX,
    AccountModel,
    EmailModel,
    Expected,
    Metric,
    PromoModel,
    QuestionModel,
    SessionModel,
    WorldModel,
    token_digest,
)
from app.checkout.client import CHECKOUT_SESSION_PATTERN
from app.funnel import mail as funnel_mail
from app.promo_code.models import PromoCode
from harness.api import (
    ACCOUNT_ACTION_PATH,
    ACCOUNT_CHARGE_PATH,
    ACCOUNT_CHECKOUT_FINISH_PATH,
    ACCOUNT_CHECKOUT_PATH,
    ACCOUNT_PATH,
    ACCOUNT_PROMO_PATH,
    ACCOUNT_QUESTION_FINISH_PATH,
    ACCOUNT_QUESTION_PATH,
    BEACON_CONTENT_TYPE,
    FUNNEL_CLICK_PATH,
    FUNNEL_DOWNLOAD_PATH,
    FUNNEL_EMAIL_PATH,
    STRIPE_EVENT_PATH,
)
from harness.sendgrid import SendgridFake
from harness.simulation.exceptions import SimulationDatabaseFaultError
from harness.simulation.fault import (
    DATABASE_FAULT_MESSAGE,
    NetworkFate,
    database_faults_installed,
)
from harness.simulation.invariant import invariant_violated, rows_clean
from harness.simulation.run import STEP_COUNT_MAX
from harness.simulation.swarm import swarm_names_of, swarmed
from harness.stripe import (
    STRIPE_PUBLISHABLE_KEY,
    STRIPE_WEBHOOK_SECRET,
    StripeFake,
    stripe_event_payload,
    stripe_signature_header,
)

if TYPE_CHECKING:
    import pytest

    from collections.abc import Callable
    from urllib.request import Request
    from urllib.response import addinfourl

    from stripe.params.checkout import SessionCreateParams

    from django.test import Client
    from django.test.client import _MonkeyPatchedWSGIResponse

    from harness.metric import MetricExecutorFake
    from harness.simulation.fault import Faults
    from harness.simulation.run import Run


    Response = _MonkeyPatchedWSGIResponse


CAMPAIGNS_DECLARED = ('general', 'wib')
CAMPAIGN_UNDECLARED = 'gala'
CHARGE_SECONDS_CHOICES = (1, 59, 60, 61, 599, 600, 3599, 3600, 3601, 7200, 21_600)
CHARGE_SECONDS_INVALID = (0, -1, 21_601)
CHECKOUT_HOURS_INVALID = (0, CHECKOUT_HOURS_MAX + 1)
CHECKOUT_HOURS_VALID = (1, 7, 50, CHECKOUT_HOURS_MAX)
EMAIL_DAY_COUNT_MAX = 6
EMAILS_INVALID = ('not-an-email', 'avery@', '   ', 'a' * 250 + '@example.com')
EVENT_ASYNC_SUCCEEDED = 'checkout.session.async_payment_succeeded'
EVENT_COMPLETED = 'checkout.session.completed'
EVENT_UNRELATED = 'customer.created'
EXCEPTION_CHAIN_DEPTH_MAX = 32
IDLE_SECONDS_CHOICES = (600, 3600, 6 * 3600, 86_400, 3 * 86_400, 31 * 86_400)
JOB_IDS_INVALID = ('short', '86DFB1D3B0140ECF2FD59075421F1CB5')
NAME_LENGTH_MAX = 200
NAMES_INVALID = ('', '   ', 'x' * 201)
NAMES_VALID = ('Avery', '  Morgan Lee ', 'R')
PAGES_DECLARED = ('landing', 'promo')
PLATFORMS_DECLARED = ('linux', 'macos', 'windows')
PROMO_CODE_OVERLONG = 'P' * 65
QUESTION_ID_UNKNOWN = 999_999
QUESTION_IDS_INVALID = (0, -3)
QUESTION_TOKENS_INVALID = (0, 1_000_001)
REGIONS_INVALID = ('', ' CA-AB', 'CA-XX', 'ca-ab', 'US-DC', 'US-NY', 'outside')
REGIONS_VALID = ('CA-AB', 'CA-NU', 'CA-ON', 'CA-QC', 'CA-YT')
REGION_UNKNOWN_MESSAGE = 'Choose your province or territory.'
RETRY_ATTEMPTS_MAX = 3
SESSION_ID_INVALID = 'pi_3Hremi'
SESSION_ID_UNKNOWN = 'cs_test_missing'
SESSION_IDS_UNKNOWN = (SESSION_ID_INVALID, SESSION_ID_UNKNOWN)
SIGNATURE_STALE_SECONDS = 400
SIGNINGS = ('forged', 'missing', 'stale', 'valid')
STATUS_TRANSIENT_MIN = 500
STATUS_TOO_MANY = 429
STATUSES_KNOWN = frozenset(HTTPStatus)
ROWS_CHECK_EVERY_STEPS = 50
TOKEN_CHECK_EVERY_STEPS = 25

ACTIONS_APP = (
    'ask-folder-question',
    'ask-library-question',
    'ask-note-question',
    'change-theme',
    'in-app-recording',
    'new-chat',
    'new-folder-created',
    'new-template',
    'upload-recording',
)

ACTIONS_REFUSED = (
    'hours-transcribed',
    'meeting-transcribed',
    'purchase-hours',
    'new-meeting',
    'NEW-CHAT',
)

EMAILS_VALID = (
    'avery@example.com',
    'Avery@Example.com',
    'morgan@example.com',
    'riley@example.com',
    'quinn@example.com',
    'sam@example.com',
)

SHARED_PROMOS = (
    PromoModel(
        campaign='wib',
        code='WIB2026',
        email='',
        hours=50,
        redemptions_max=12,
        early_codes_max=2,
        early_hours=75,
    ),
    PromoModel(campaign='general', code='FRIEND', email='', hours=5, redemptions_max=3),
    PromoModel(campaign='general', code='SPENT', email='', hours=1, redemptions_max=0),
    PromoModel(campaign='general', code='PAUSED', email='', hours=2, redemptions_max=9),
)


class Exchange(NamedTuple):
    label: str
    reconcile: Callable[[], None]
    retried: bool
    send: Callable[[], Response]
    settle: Callable[[Response], None]


class SignupForm(NamedTuple):
    email: str
    name: str
    promo_code: str
    region: str


class SimulatedStripe(StripeFake):
    def __init__(self) -> None:
        super().__init__()

        self.fault_next = False

    def _fault_take(self) -> bool:
        fault = self.fault_next
        self.fault_next = False

        return fault

    def create(self, parameters: SessionCreateParams) -> stripe.checkout.Session:
        assert parameters.get('client_reference_id', '') != ''
        assert parameters.get('line_items')

        if self._fault_take():
            message = 'simulated Stripe fault'
            raise stripe.APIConnectionError(message)

        return super().create(parameters)

    def retrieve(self, session_id: str) -> stripe.checkout.Session:
        assert CHECKOUT_SESSION_PATTERN.fullmatch(session_id) is not None
        assert session_id in self.sessions or session_id == SESSION_ID_UNKNOWN

        if self._fault_take():
            message = 'simulated Stripe fault'
            raise stripe.APIConnectionError(message)

        return super().retrieve(session_id)


class SimulatedSendgrid(SendgridFake):
    def __init__(self) -> None:
        super().__init__()

        self.delivered: list[tuple[str, float]] = []
        self.fault_next = False

    def open(self, request: Request, timeout: float | None = None) -> addinfourl:
        assert request.get_method() == 'POST'
        assert timeout is None or timeout > 0

        self.error = None

        if self.fault_next:
            self.fault_next = False
            self.error = TimeoutError('simulated SendGrid fault')

        response = super().open(request, timeout)
        recipient = self.requests[-1].payload['personalizations'][0]['to'][0]['email']

        self.delivered.append((recipient, time.time()))

        return response


@dataclass
class RemiWorld:
    client: Client
    metric: MetricExecutorFake
    model: WorldModel
    sendgrid: SimulatedSendgrid
    stripe: SimulatedStripe
    faults: Faults | None = None
    sessions_foreign: int = 0
    tokens_garbage: list[str] = field(default_factory=lambda: ['garbage-token'])


def _body(response: Response) -> dict[str, Any]:
    assert response.status_code != HTTPStatus.NO_CONTENT
    assert response['Content-Type'].startswith('application/json')

    return response.json()


def _expected_check(response: Response, expected: Expected, label: str) -> None:
    assert response.status_code in STATUSES_KNOWN
    assert (expected.code == '') == (expected.status < HTTPStatus.BAD_REQUEST)
    assert label != ''

    if response.status_code != expected.status:
        content = response.content.decode(errors='replace')[:400]
        message = f'{label}: expected {expected.status}, got {response.status_code}: {content}'
        invariant_violated(message)

    if expected.code == '':
        return

    error = _body(response)['error']

    if error['code'] != expected.code:
        invariant_violated(f'{label}: expected {expected.code}, got {error}')

    if expected.message != '':
        if error['message'] != expected.message:
            invariant_violated(f'{label}: expected {expected.message!r}, got {error["message"]!r}')


def _signup_form_refusal(form: SignupForm) -> Expected | None:
    assert isinstance(form.email, str)
    assert isinstance(form.name, str)
    assert isinstance(form.promo_code, str)
    assert isinstance(form.region, str)

    email_clean = form.email.strip()

    if len(email_clean) > 254:
        message = 'Enter an email address of at most 254 characters.'
        return Expected('request_invalid', message, 400)

    if not 0 < len(form.name.strip()) <= NAME_LENGTH_MAX:
        return Expected('request_invalid', 'Enter a name of 1 to 200 characters.', 400)

    if form.region not in REGIONS_VALID:
        return Expected('request_invalid', REGION_UNKNOWN_MESSAGE, 400)

    if len(form.promo_code.strip()) > PROMO_CODE_LENGTH_MAX:
        return Expected('promo_invalid', 'A promo code has at most 64 characters.', 400)

    if email_clean not in EMAILS_VALID:
        return Expected('request_invalid', 'Enter a valid email address.', 400)

    return None


def _database_fault_in(error: BaseException) -> bool:
    assert error.__traceback__ is not None

    current: BaseException | None = error

    for _ in range(EXCEPTION_CHAIN_DEPTH_MAX):
        if current is None:
            return False

        if isinstance(current, SimulationDatabaseFaultError):
            return True

        if isinstance(current, PydanticValidationError):
            details = current.errors(include_url=False)
            reasons = [str(detail.get('ctx', {}).get('error', '')) for detail in details]

            if any(DATABASE_FAULT_MESSAGE in reason for reason in reasons):
                return True

        current = current.__cause__ or current.__context__

    message = f'an exception chain ran past {EXCEPTION_CHAIN_DEPTH_MAX} links'
    raise RuntimeError(message)


def _status_transient(status: int) -> bool:
    assert status in STATUSES_KNOWN

    return status == STATUS_TOO_MANY or status >= STATUS_TRANSIENT_MIN


class RemiSimulation:
    def __init__(self, world: RemiWorld) -> None:
        assert not world.model.accounts
        assert not world.model.promos

        self.world = world
        self.model = world.model
        self.actions_enabled = self._actions_weighted()
        self.reconciled: list[str] = []
        self.rows_clean = rows_clean(
            Account,
            AccountLedgerEntry,
            AccountPayment,
            AccountQuestion,
            PromoCode,
        )

    def actions(self) -> tuple[Callable[[Run], None], ...]:
        assert self.actions_enabled

        return self.actions_enabled

    def swarm(self, rng: random.Random) -> None:
        assert isinstance(rng, random.Random)

        actions_all = self._actions_weighted()
        self.actions_enabled = swarmed(actions_all, rng)

        assert self.actions_enabled
        assert set(self.actions_enabled) <= set(actions_all)

    def setup(self, run: Run) -> None:
        assert run.step == 0
        assert not self.model.promos

        for shared in SHARED_PROMOS:
            promo = PromoCode(
                campaign=shared.campaign,
                code=shared.code,
                early_codes_max=shared.early_codes_max,
                early_hours=shared.early_hours,
                hours=shared.hours,
                redemptions_max=shared.redemptions_max,
            )

            promo.services.save_model_obj()

            model = PromoModel(
                campaign=shared.campaign,
                code=shared.code,
                email='',
                hours=shared.hours,
                redemptions_max=shared.redemptions_max,
                early_codes_max=shared.early_codes_max,
                early_hours=shared.early_hours,
            )

            self.model.promos[shared.code.upper()] = model

        paused = PromoCode.objects.get(code='PAUSED')
        paused.services.processor.active_set(is_active=False)
        self.model.promos['PAUSED'].is_active = False

        assert len(self.model.promos) == len(SHARED_PROMOS)

        run.log(f'swarm actions={swarm_names_of(self.actions_enabled)}')

    def _actions_weighted(self) -> tuple[Callable[[Run], None], ...]:
        weighted = (
            (self.account_read, 2),
            (self.action, 2),
            (self.charge, 6),
            (self.checkout_finish, 3),
            (self.checkout_start, 3),
            (self.click, 2),
            (self.complimentary_end, 1),
            (self.complimentary_start, 1),
            (self.download, 2),
            (self.email, 3),
            (self.idle, 1),
            (self.promo_create, 1),
            (self.promo_redeem, 3),
            (self.promo_terms, 1),
            (self.promo_toggle, 1),
            (self.question_burst, 1),
            (self.question_finish, 3),
            (self.question_start, 4),
            (self.signup, 5),
            (self.stripe_foreign, 1),
            (self.stripe_pay, 3),
            (self.token_issue, 1),
            (self.webhook, 3),
        )

        actions = tuple(action for action, weight in weighted for _ in range(weight))

        assert len(set(actions)) == len(weighted)

        return actions

    def jobs_nightly(self) -> None:
        reference_prefix = 'topup:nightly:'
        grants = AccountLedgerEntry.objects.grants()
        before = list(grants.values_list('pk', flat=True))

        Account.services.automation.complimentary_topup()

        for entry in grants.exclude(pk__in=before).order_by('pk'):
            if not entry.reference.startswith(reference_prefix):
                invariant_violated(f'nightly grant carries reference {entry.reference!r}')

            account = self.model.accounts[entry.account_id]

            assert account.complimentary

            seconds = self.model.topup_apply(account, entry.reference)

            if seconds != entry.seconds:
                invariant_violated(
                    f'nightly top-up granted {entry.seconds} seconds to {account.id}, '
                    f'the model {seconds}',
                )

        for account in self.model.accounts.values():
            if account.complimentary:
                if account.balance < TOPUP_BALANCE_SECONDS:
                    invariant_violated(f'nightly top-up left {account.id} at {account.balance}')

    def _account_pick(self, run: Run) -> AccountModel | None:
        assert 0 <= run.step < STEP_COUNT_MAX

        known = [account for account in self.model.accounts.values() if account.token]

        if not known:
            run.log('no signed-in account')

            return None

        account = run.rng.choice(known)

        assert account.token is not None

        return account

    def _account_json(self, account: AccountModel) -> dict[str, object]:
        assert self.model.accounts.get(account.id) is account
        assert account.email == account.email.strip()

        return {
            'balance_seconds': account.balance,
            'checkout_hours_max': CHECKOUT_HOURS_MAX,
            'email': account.email,
            'name': account.name,
            'offers': self.model.offers_listed(settings.REMI_PRICE_CURRENCY),
            'payments': True,
            'price_currency': settings.REMI_PRICE_CURRENCY,
            'price_hour_cents': self.model.price_hour_cents,
            'publishable_key': STRIPE_PUBLISHABLE_KEY,
        }

    def _exchange(self, run: Run, exchange: Exchange) -> Response | None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert exchange.label != ''

        attempts = RETRY_ATTEMPTS_MAX if exchange.retried else 1

        for attempt in range(attempts):
            fate = NetworkFate.DELIVERED

            if self.world.faults is not None:
                fate = self.world.faults.network_fate(run.rng)

            if fate == NetworkFate.REQUEST_DROPPED:
                run.log(f'{exchange.label} attempt {attempt} dropped before the server')
                run.sometimes('request dropped before the server')

                continue

            response = self._attempt(run, exchange)

            if fate == NetworkFate.RESPONSE_LOST:
                run.log(f'{exchange.label} attempt {attempt} answered, the answer lost')
                run.sometimes('response lost after the server acted')

                continue

            if response is None:
                continue

            if exchange.retried:
                if _status_transient(response.status_code):
                    run.sometimes('transient answer retried')

                    continue

            return response

        return None

    def _attempt(self, run: Run, exchange: Exchange) -> Response | None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert exchange.label != ''

        faults = self.world.faults

        if faults is not None:
            if faults.database_rate > 0.0:
                return self._attempt_faulted(run, exchange, faults)

        response = exchange.send()
        exchange.settle(response)

        return response

    def _attempt_faulted(self, run: Run, exchange: Exchange, faults: Faults) -> Response | None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert exchange.label != ''
        assert faults.database_rate > 0.0

        try:
            with database_faults_installed(faults, run.rng) as tally:
                response = exchange.send()
        except Exception as error:
            if not _database_fault_in(error):
                raise

            self._database_fault_reconcile(run, exchange)

            return None

        if tally.count > 0:
            if response.status_code == HTTPStatus.INTERNAL_SERVER_ERROR:
                self._database_fault_reconcile(run, exchange)

                return None

        exchange.settle(response)

        return response

    def _database_fault_reconcile(self, run: Run, exchange: Exchange) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert exchange.label != ''

        run.log(f'{exchange.label} hit a database fault')
        run.sometimes('database fault mid-request')
        reconciled_before = len(self.reconciled)
        exchange.reconcile()
        committed = len(self.reconciled) > reconciled_before

        run.sometimes('database fault after the write committed', condition=committed)

    def _post_json(self, path: str, body: object, token: str | None) -> Response:
        assert path.startswith('/api/v1/account/')
        assert isinstance(body, dict)
        assert token != ''

        headers = {} if token is None else {'Authorization': f'Bearer {token}'}

        return self.world.client.post(
            path,
            data=body,
            content_type='application/json',
            headers=headers,
        )

    def _beacon(self, path: str, fields: dict[str, str]) -> Response:
        assert path.startswith('/api/v1/funnel/')
        assert fields

        body = urlencode(fields)
        return self.world.client.post(path, data=body, content_type=BEACON_CONTENT_TYPE)

    def _promo_code_choice(self, run: Run) -> str:
        assert 0 <= run.step < STEP_COUNT_MAX

        personal = [promo.code for promo in self.model.promos.values() if promo.email != '']

        choices = [
            '',
            'WIB2026',
            'wib2026',
            ' FRIEND ',
            'friend',
            'SPENT',
            'PAUSED',
            'NOSUCHCODE',
            PROMO_CODE_OVERLONG,
            *[promo.code for promo in self.model.promos.values()],
            *personal,
            *[code.lower() for code in personal],
        ]

        code = run.rng.choice(choices)

        assert len(code) <= len(PROMO_CODE_OVERLONG)

        return code

    def signup(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        email_raw = run.rng.choice(EMAILS_VALID + EMAILS_VALID + EMAILS_INVALID)
        email = run.rng.choice([email_raw, f'  {email_raw} '])
        name = run.rng.choice(NAMES_VALID * 4 + NAMES_INVALID)
        promo_code = run.rng.choice(['', '', self._promo_code_choice(run)])
        region = run.rng.choice(REGIONS_VALID * 4 + REGIONS_INVALID)
        form = SignupForm(email=email, name=name, promo_code=promo_code, region=region)
        body = form._asdict()
        expected = self._signup_expected(form)
        known_pks = set(self.model.accounts)
        created: list[AccountModel] = []

        def send() -> Response:
            assert not created
            assert known_pks == self.model.accounts.keys()

            return self._post_json(ACCOUNT_PATH, body, None)

        def settle(response: Response) -> None:
            assert response.status_code in STATUSES_KNOWN
            assert not created

            _expected_check(response, expected, 'signup')

            if response.status_code != 201:
                return

            reply = _body(response)
            account = self._signup_apply(form, reply['token'])

            created.append(account)

            if reply['account'] != self._account_json(account):
                invariant_violated(f'signup answered {reply["account"]} for {account}')

        def reconcile() -> None:
            assert self.world.faults is not None
            assert not created

            accounts = self._signup_reconcile(form, known_pks)

            created.extend(accounts)

        exchange = Exchange('signup', reconcile, retried=False, send=send, settle=settle)
        response = self._exchange(run, exchange)

        assert len(created) <= 1

        if response is None:
            for account in created:
                account.token = None
                run.sometimes('signup answer lost, account orphaned')

        run.sometimes('signup created an account', condition=expected.status == 201)
        run.sometimes('signup refused a promo', condition=expected.code == 'promo_invalid')

        run.sometimes(
            'signup refused a region',
            condition=expected.message == REGION_UNKNOWN_MESSAGE,
        )

        run.sometimes('signup with a promo', condition=expected.status == 201 and promo_code != '')

    def _signup_expected(self, form: SignupForm) -> Expected:
        assert form.email.isprintable()
        assert form.name.isprintable()
        assert form.promo_code.isprintable()
        assert form.region.isprintable()

        refusal = _signup_form_refusal(form)

        if refusal is not None:
            return refusal

        if form.promo_code.strip() == '':
            return Expected('', '', 201)

        refusal = self.model.promo_refusal(account_email=form.email.strip(), code=form.promo_code)
        return refusal or Expected('', '', 201)

    def _signup_apply(self, form: SignupForm, token: str) -> AccountModel:
        assert form.email.strip() in EMAILS_VALID
        assert 0 < len(form.name.strip()) <= NAME_LENGTH_MAX
        assert len(form.promo_code.strip()) <= PROMO_CODE_LENGTH_MAX
        assert form.region in REGIONS_VALID
        assert token != ''

        stored = Account.objects.by_token_hash(token_digest(token)).get()

        if stored.pk in self.model.accounts:
            invariant_violated(f'signup reused account {stored.pk}')

        account = AccountModel(
            campaign='general',
            email=form.email.strip(),
            id=stored.pk,
            name=form.name.strip(),
            region=form.region,
            token=token,
            token_hash=token_digest(token),
        )

        self.model.accounts[account.id] = account

        if form.promo_code.strip() != '':
            self.model.promo_apply(account, form.promo_code)

        self.model.signup_record(account)

        return account

    def _signup_reconcile(self, form: SignupForm, known_pks: set[int]) -> list[AccountModel]:
        assert form.email.isprintable()
        assert form.name.isprintable()
        assert form.promo_code.isprintable()
        assert form.region.isprintable()
        assert known_pks == self.model.accounts.keys()

        stored = list(Account.objects.exclude(pk__in=known_pks).order_by('pk'))

        if not stored:
            return []

        if len(stored) != 1:
            invariant_violated(f'one signup left {len(stored)} accounts')

        row = stored[0]
        self.reconciled.append('signup committed before a database fault')

        account = AccountModel(
            campaign='general',
            email=form.email.strip(),
            id=row.pk,
            name=form.name.strip(),
            region=form.region,
            token=None,
            token_hash=row.token_hash,
        )

        self.model.accounts[account.id] = account

        if form.promo_code.strip() != '':
            self.model.promo_apply(account, form.promo_code)

        self.model.signup_record(account)

        return [account]

    def account_read(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        account = self._account_pick(run)

        if account is None:
            return

        choice = run.rng.random()
        token = account.token
        expected = Expected('', '', 200)

        if choice < 0.15:
            pool = self.world.tokens_garbage

            if choice < 0.1:
                if account.tokens_retired:
                    pool = account.tokens_retired

            token = run.rng.choice(pool)
            expected = Expected('token_invalid', '', 401)
        else:
            run.sometimes('account read with its token')

        assert (token == account.token) == (expected.status == HTTPStatus.OK)

        headers = {'Authorization': f'Bearer {token}'}

        def send() -> Response:
            assert self.model.accounts.get(account.id) is account

            return self.world.client.get(ACCOUNT_PATH, headers=headers)

        def settle(response: Response) -> None:
            assert response.status_code in STATUSES_KNOWN
            assert self.model.accounts.get(account.id) is account

            _expected_check(response, expected, 'account read')

            if response.status_code == 200:
                if _body(response) != self._account_json(account):
                    invariant_violated(f'account read answered {_body(response)} for {account}')

        exchange = Exchange('account read', lambda: None, retried=True, send=send, settle=settle)

        self._exchange(run, exchange)

    def action(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        account = self._account_pick(run)

        if account is None:
            return

        action = run.rng.choice([*ACTIONS_APP, *ACTIONS_APP, *ACTIONS_REFUSED])
        body = {'action': action}
        token = account.token
        expected = Expected('', '', 204)

        if action in ACTIONS_REFUSED:
            expected = Expected('request_invalid', 'That is not an action remi counts.', 400)

        if run.rng.random() < 0.1:
            token = run.rng.choice(self.world.tokens_garbage)
            expected = Expected('token_invalid', '', 401)

        def send() -> Response:
            assert token is not None
            assert self.model.accounts.get(account.id) is account

            return self._post_json(ACCOUNT_ACTION_PATH, body, token)

        def settle(response: Response) -> None:
            assert response.status_code in STATUSES_KNOWN
            assert self.model.accounts.get(account.id) is account

            _expected_check(response, expected, 'action')

            counted = response.status_code == HTTPStatus.NO_CONTENT
            refused = expected.code == 'request_invalid'

            run.sometimes('action counted', condition=counted)
            run.sometimes('action refused as no app action', condition=refused)

            if counted:
                self.model.metric_add(f'remi:action:{action}')

        exchange = Exchange('action', lambda: None, retried=False, send=send, settle=settle)

        self._exchange(run, exchange)

    def charge(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        account = self._account_pick(run)

        if account is None:
            return

        assert len(account.charges_asked) == len(account.charges)

        job_id = f'{run.rng.getrandbits(128):032x}'

        if account.charges:
            if run.rng.random() < 0.25:
                job_id = run.rng.choice(sorted(account.charges))

        if run.rng.random() < 0.04:
            job_id = run.rng.choice(JOB_IDS_INVALID)

        seconds_choices = [*CHARGE_SECONDS_CHOICES, max(account.balance, 1), account.balance + 1]
        seconds = run.rng.choice([*seconds_choices, *seconds_choices, *CHARGE_SECONDS_INVALID])
        body = {'job_id': job_id, 'seconds': seconds}

        def send() -> Response:
            assert account.token is not None
            assert self.model.accounts.get(account.id) is account

            return self._post_json(ACCOUNT_CHARGE_PATH, body, account.token)

        def settle(response: Response) -> None:
            assert response.status_code in STATUSES_KNOWN
            assert self.model.accounts.get(account.id) is account

            expected = self._charge_expected(account, job_id, seconds)

            _expected_check(response, expected, 'charge')

            if response.status_code == 200:
                repeated = job_id in account.charges
                self.model.charge_apply(account, job_id, seconds)

                run.sometimes('charge repeated for a job', condition=repeated)
                run.sometimes('charge taken', condition=not repeated)

                if _body(response) != self._account_json(account):
                    invariant_violated(f'charge answered {_body(response)} for {account}')

            run.sometimes('charge refused for balance', condition=response.status_code == 402)

        def reconcile() -> None:
            assert self.world.faults is not None
            assert self.model.accounts.get(account.id) is account

            if job_id in account.charges:
                return

            entry = account_entry(
                account_id=account.id,
                kind=AccountLedgerEntryKindChoices.CHARGE,
                reference=job_id,
            )

            if entry is not None:
                self.reconciled.append('charge committed before a database fault')
                self.model.charge_apply(account, job_id, seconds)

        exchange = Exchange('charge', reconcile, retried=True, send=send, settle=settle)

        self._exchange(run, exchange)

    def _charge_expected(self, account: AccountModel, job_id: str, seconds: int) -> Expected:
        assert self.model.accounts.get(account.id) is account
        assert JOB_ID_PATTERN.fullmatch(job_id) is not None or job_id in JOB_IDS_INVALID
        assert seconds > 0 or seconds in CHARGE_SECONDS_INVALID

        if job_id in JOB_IDS_INVALID:
            return Expected('request_invalid', '', 400)

        if not 0 < seconds <= 21_600:
            return Expected('request_invalid', '', 400)

        return self.model.charge_expected(account, job_id, seconds)

    def promo_redeem(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        account = self._account_pick(run)

        if account is None:
            return

        assert account.promos.keys() <= {promo.code for promo in self.model.promos.values()}

        code = self._promo_code_choice(run)
        body = {'code': code}
        refusal = self.model.promo_refusal(account_email=account.email, code=code)
        expected = refusal or Expected('', '', 200)

        def send() -> Response:
            assert account.token is not None
            assert self.model.accounts.get(account.id) is account

            return self._post_json(ACCOUNT_PROMO_PATH, body, account.token)

        def settle(response: Response) -> None:
            assert response.status_code in STATUSES_KNOWN
            assert self.model.accounts.get(account.id) is account

            _expected_check(response, expected, 'promo redeem')

            if response.status_code == 200:
                self.model.promo_apply(account, code)

                if _body(response) != self._account_json(account):
                    invariant_violated(f'promo answered {_body(response)} for {account}')

        def reconcile() -> None:
            assert self.world.faults is not None
            assert self.model.accounts.get(account.id) is account

            promo = self.model.promo_find(code) if code.strip() != '' else None

            if promo is None:
                return

            if promo.code in account.promos:
                return

            entry = account_entry(
                account_id=account.id,
                kind=AccountLedgerEntryKindChoices.PROMO,
                reference=promo.code,
            )

            if entry is not None:
                self.model.promo_apply(account, code)

        exchange = Exchange('promo redeem', reconcile, retried=False, send=send, settle=settle)

        self._exchange(run, exchange)

        run.sometimes('promo redeemed', condition=expected.status == 200)
        run.sometimes('promo refused as spent', condition='fully redeemed' in expected.message)
        run.sometimes('promo refused for the email', condition='this email' in expected.message)
        run.sometimes('promo refused for the campaign', condition='offer.' in expected.message)
        run.sometimes('promo refused as unknown', condition='not valid' in expected.message)

    def checkout_start(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        account = self._account_pick(run)

        if account is None:
            return

        assert all(1 <= hours <= CHECKOUT_HOURS_MAX for hours in CHECKOUT_HOURS_VALID)
        assert not any(1 <= hours <= CHECKOUT_HOURS_MAX for hours in CHECKOUT_HOURS_INVALID)

        hours_choices = [*CHECKOUT_HOURS_VALID, *CHECKOUT_HOURS_VALID, *CHECKOUT_HOURS_INVALID]
        hours = run.rng.choice(hours_choices)
        body = {'hours': hours}
        fault_rolled: list[bool] = []

        def send() -> Response:
            assert account.token is not None
            assert not self.world.stripe.fault_next

            fault = self._stripe_fault_roll(run)
            fault_rolled.append(fault)
            self.world.stripe.fault_next = fault

            return self._post_json(ACCOUNT_CHECKOUT_PATH, body, account.token)

        def settle(response: Response) -> None:
            assert response.status_code in STATUSES_KNOWN
            assert fault_rolled

            self.world.stripe.fault_next = False

            if not 1 <= hours <= CHECKOUT_HOURS_MAX:
                expected = Expected('request_invalid', '', 400)
            elif fault_rolled[-1]:
                expected = Expected('payments_unavailable', '', 503)
            else:
                expected = Expected('', '', 200)

            _expected_check(response, expected, 'checkout start')

            if response.status_code == 200:
                self._checkout_started(account, hours, _body(response))

            run.sometimes('checkout started', condition=response.status_code == 200)
            run.sometimes('checkout Stripe fault', condition=response.status_code == 503)

        def reconcile() -> None:
            assert self.world.faults is not None
            assert fault_rolled

            self.world.stripe.fault_next = False

        exchange = Exchange('checkout start', reconcile, retried=True, send=send, settle=settle)

        self._exchange(run, exchange)

    def _checkout_started(self, account: AccountModel, hours: int, reply: dict[str, Any]) -> None:
        assert self.model.accounts.get(account.id) is account
        assert 1 <= hours <= CHECKOUT_HOURS_MAX
        assert reply.keys() >= {'client_secret', 'session_id'}

        session_id = reply['session_id']

        if session_id in self.model.sessions:
            invariant_violated(f'checkout reused session {session_id}')

        if reply['client_secret'] != f'{session_id}_secret_remi':
            invariant_violated(f'checkout answered secret {reply["client_secret"]!r}')

        created = self.world.stripe.created[-1]

        if created['metadata'] != {
            'account_id': str(account.id),
            'app': 'remi',
            'seconds': str(hours * SECONDS_PER_HOUR),
        }:
            invariant_violated(f'checkout sent metadata {created["metadata"]}')

        self.model.sessions[session_id] = SessionModel(
            account_pk=account.id,
            amount_cents=hours * self.model.price_hour_cents,
            hours=hours,
            owned=True,
            session_id=session_id,
        )

    def _stripe_fault_roll(self, run: Run) -> bool:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert not self.world.stripe.fault_next

        faults = self.world.faults
        return faults is not None and faults.stripe_roll(run.rng)

    def stripe_pay(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        unpaid = [session for session in self.model.sessions.values() if not session.paid]

        if not unpaid:
            run.log('no unpaid session')

            return

        session = run.rng.choice(unpaid)

        assert session.owned
        assert not session.credited

        session.paid = True

        self.world.stripe.pay(session.session_id)

        run.log(f'stripe paid {session.session_id}')

    def stripe_foreign(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        account = self._account_pick(run)

        if account is None:
            return

        self.world.sessions_foreign += 1
        session_id = f'cs_test_foreign{self.world.sessions_foreign}'
        metadata = {'account_id': str(account.id), 'app': 'business-base', 'seconds': '36000'}

        assert session_id not in self.model.sessions

        self.world.stripe.session_add(
            amount_total=5000,
            client_reference_id=str(account.id),
            metadata=metadata,
            payment_status='paid',
            session_id=session_id,
        )

        self.model.sessions[session_id] = SessionModel(
            account_pk=account.id,
            amount_cents=5000,
            hours=10,
            owned=False,
            paid=True,
            session_id=session_id,
        )

    def _session_pick(self, run: Run, account: AccountModel) -> str:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert self.model.accounts.get(account.id) is account

        own = [
            session.session_id
            for session in self.model.sessions.values()
            if session.account_pk == account.id
        ]

        others = [
            session.session_id
            for session in self.model.sessions.values()
            if session.account_pk != account.id
        ]

        choices = [*own, *own, *own, *others, SESSION_ID_UNKNOWN, SESSION_ID_INVALID]
        return run.rng.choice(choices)

    def checkout_finish(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        account = self._account_pick(run)

        if account is None:
            return

        assert all(session.paid for session in self.model.sessions.values() if session.credited)

        session_id = self._session_pick(run, account)
        body = {'session_id': session_id}
        fault_rolled: list[bool] = []

        def send() -> Response:
            assert account.token is not None
            assert not self.world.stripe.fault_next

            fault = self._stripe_fault_roll(run)
            fault_rolled.append(fault)
            self.world.stripe.fault_next = fault

            return self._post_json(ACCOUNT_CHECKOUT_FINISH_PATH, body, account.token)

        def settle(response: Response) -> None:
            assert response.status_code in STATUSES_KNOWN
            assert fault_rolled

            self.world.stripe.fault_next = False
            expected = self._finish_expected(account, session_id, fault=fault_rolled[-1])

            _expected_check(response, expected, 'checkout finish')

            if response.status_code != 200:
                return

            session = self.model.sessions[session_id]
            credited_before = session.credited

            if session.paid:
                self.model.purchase_apply(session)

            reply = _body(response)

            if reply != {'account': self._account_json(account), 'paid': session.paid}:
                invariant_violated(f'checkout finish answered {reply} for {account}')

            credited = session.paid and not credited_before

            run.sometimes('purchase credited by finish', condition=credited)
            run.sometimes('finish of an unpaid session', condition=not session.paid)

        def reconcile() -> None:
            assert self.world.faults is not None
            assert fault_rolled

            self.world.stripe.fault_next = False
            self._purchase_reconcile(session_id)

        exchange = Exchange('checkout finish', reconcile, retried=True, send=send, settle=settle)

        self._exchange(run, exchange)

    def _finish_expected(self, account: AccountModel, session_id: str, *, fault: bool) -> Expected:
        assert self.model.accounts.get(account.id) is account
        assert session_id in self.model.sessions or session_id in SESSION_IDS_UNKNOWN

        unknown = Expected('checkout_unknown', 'Stripe has no checkout session with that id.', 404)

        if session_id == SESSION_ID_INVALID:
            return Expected('checkout_unknown', 'That is not a Stripe checkout session.', 404)

        if fault:
            return Expected('payments_unavailable', '', 503)

        session = self.model.sessions.get(session_id)

        if session is None:
            return unknown

        if session.account_pk != account.id:
            return unknown

        if not session.owned:
            return unknown

        return Expected('', '', 200)

    def _purchase_reconcile(self, session_id: str) -> None:
        assert self.world.faults is not None
        assert session_id in self.model.sessions or session_id in SESSION_IDS_UNKNOWN

        session = self.model.sessions.get(session_id)

        if session is None:
            return

        if session.credited:
            return

        exists = AccountLedgerEntry.objects.purchases().by_reference(session_id).exists()

        if exists:
            self.model.purchase_apply(session)

    def webhook(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert not self.world.stripe.fault_next

        session_ids = [*self.model.sessions, SESSION_ID_UNKNOWN]
        session_id = run.rng.choice(session_ids)
        event_types = [EVENT_COMPLETED] * 3 + [EVENT_ASYNC_SUCCEEDED, EVENT_UNRELATED]
        event_type = run.rng.choice(event_types)
        signing = run.rng.choice(['valid'] * 8 + ['stale', 'forged', 'missing'])
        payload = stripe_event_payload(event_type=event_type, session_id=session_id)
        header = self._webhook_header(payload=payload, signing=signing)
        fault = self._stripe_fault_roll(run)

        expected = self._webhook_expected(
            session_id=session_id,
            event_type=event_type,
            signing=signing,
            fault=fault,
        )

        session = self.model.sessions.get(session_id)
        credited_before = session is not None and session.credited

        self.world.stripe.fault_next = fault and signing == 'valid'

        def send() -> Response:
            assert (header == '') == (signing == 'missing')
            assert payload.startswith('{')

            headers = {} if header == '' else {'Stripe-Signature': header}

            return self.world.client.post(
                STRIPE_EVENT_PATH,
                data=payload,
                content_type='application/json',
                headers=headers,
            )

        def settle(response: Response) -> None:
            assert response.status_code in STATUSES_KNOWN
            assert session is None or self.model.sessions.get(session_id) is session

            self.world.stripe.fault_next = False

            if response.status_code != expected.status:
                status = response.status_code
                body = response.content[:300]
                invariant_violated(f'webhook expected {expected.status}, got {status}: {body}')

            if expected.code == 'credit':
                if session is not None:
                    self.model.purchase_apply(session)

        def reconcile() -> None:
            assert self.world.faults is not None
            assert session is None or self.model.sessions.get(session_id) is session

            self.world.stripe.fault_next = False
            self._purchase_reconcile(session_id)

        exchange = Exchange('webhook', reconcile, retried=False, send=send, settle=settle)

        self._exchange_server(run, exchange)

        credited = session is not None and session.credited and not credited_before

        run.sometimes('purchase credited by webhook', condition=credited)
        run.sometimes('webhook for an unpaid session', condition=expected.code == 'unpaid')
        run.sometimes('webhook signature refused', condition=expected.status == 400)
        run.sometimes('webhook for another app', condition=expected.code == 'foreign')

    def _exchange_server(self, run: Run, exchange: Exchange) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert not exchange.retried

        response = self._attempt(run, exchange)

        if response is None:
            run.log(f'{exchange.label} failed, Stripe would retry')

    def _webhook_header(self, *, payload: str, signing: str) -> str:
        assert payload.startswith('{')
        assert signing in SIGNINGS

        now = int(time.time())

        if signing == 'missing':
            return ''

        if signing == 'forged':
            return stripe_signature_header(payload, secret='whsec_forged', timestamp=now)

        if signing == 'stale':
            stale = now - SIGNATURE_STALE_SECONDS
            return stripe_signature_header(payload, secret=STRIPE_WEBHOOK_SECRET, timestamp=stale)

        return stripe_signature_header(payload, secret=STRIPE_WEBHOOK_SECRET, timestamp=now)

    def _webhook_expected(
        self,
        *,
        session_id: str,
        event_type: str,
        signing: str,
        fault: bool,
    ) -> Expected:
        assert session_id in self.model.sessions or session_id == SESSION_ID_UNKNOWN
        assert event_type in (EVENT_ASYNC_SUCCEEDED, EVENT_COMPLETED, EVENT_UNRELATED)
        assert signing in SIGNINGS

        if signing != 'valid':
            return Expected('', '', 400)

        if event_type == EVENT_UNRELATED:
            return Expected('', '', 200)

        if fault:
            return Expected('', '', 503)

        session = self.model.sessions.get(session_id)

        if session is None:
            return Expected('', '', 404)

        return _webhook_session_expected(session)

    def question_start(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        account = self._account_pick(run)

        if account is None:
            return

        assert len({item.question_id for item in account.questions}) == len(account.questions)

        self._question_start_for(run, account)

    def _question_start_for(self, run: Run, account: AccountModel) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert self.model.accounts.get(account.id) is account

        def send() -> Response:
            assert account.token is not None
            assert self.model.accounts.get(account.id) is account

            return self._post_json(ACCOUNT_QUESTION_PATH, {}, account.token)

        def settle(response: Response) -> None:
            assert response.status_code in STATUSES_KNOWN
            assert self.model.accounts.get(account.id) is account

            self._question_started(run, account, response)

        def reconcile() -> None:
            assert self.world.faults is not None
            assert self.model.accounts.get(account.id) is account

            known = {question.question_id for question in account.questions}
            stored = AccountQuestion.objects.filter(account_id=account.id).exclude(pk__in=known)

            for question in stored.order_by('pk'):
                self._question_add(account, question.pk)

        exchange = Exchange('question start', reconcile, retried=True, send=send, settle=settle)

        self._exchange(run, exchange)

    def question_burst(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert self.model.limits.burst_count > 0

        account = self._account_pick(run)

        if account is None:
            return

        for _ in range(self.model.limits.burst_count + 1):
            self._question_start_for(run, account)

    def _question_started(self, run: Run, account: AccountModel, response: Response) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert self.model.accounts.get(account.id) is account
        assert response.status_code in STATUSES_KNOWN

        now = timezone.now()

        if not self.model.ask_active(account, now):
            _expected_check(response, Expected('ask_inactive', '', 403), 'question start')
            run.sometimes('ask inactive without a recent recording')

            return

        pace = self.model.ask_pace_expected(account, now)

        _expected_check(response, Expected('', '', 200), 'question start')

        reply = _body(response)
        message = f'question start answered {reply}, the model {pace}'

        if reply['notice'] != pace.notice:
            invariant_violated(message)

        if reply['wait_seconds'] != pace.wait_seconds:
            invariant_violated(message)

        if pace.wait_seconds > 0:
            if reply['question_id'] is not None:
                invariant_violated(f'question start admitted {reply} while pacing')

            burst = 'questions in the last' in pace.notice
            capped = 'a lot this month' in pace.notice

            run.sometimes('question paced to wait for the burst', condition=burst)
            run.sometimes('question paced past the soft cap', condition=capped)

            return

        self._question_add(account, reply['question_id'])

        run.sometimes('question admitted')
        run.sometimes('question admitted with a heads-up', condition=pace.notice != '')

    def _question_add(self, account: AccountModel, question_id: int) -> None:
        assert self.model.accounts.get(account.id) is account
        assert question_id > 0
        assert all(question.question_id != question_id for question in account.questions)

        now = timezone.now()
        _, usage = self.model.ask_usage(account, now)

        question = QuestionModel(
            asked=now,
            finished=False,
            question_id=question_id,
            tokens=self.model.limits.tokens_estimate,
            tokens_window_before=usage.tokens,
        )

        account.questions.append(question)

    def question_finish(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        account = self._account_pick(run)

        if account is None:
            return

        question_id, owner = self._question_target(run, account)
        tokens_valid = [run.rng.randint(1, 40_000)] * 6
        tokens = run.rng.choice([*tokens_valid, *QUESTION_TOKENS_INVALID])
        body = {'question_id': question_id, 'tokens': tokens}

        assert owner is None or owner is account

        def send() -> Response:
            assert account.token is not None
            assert self.model.accounts.get(account.id) is account

            return self._post_json(ACCOUNT_QUESTION_FINISH_PATH, body, account.token)

        def settle(response: Response) -> None:
            assert response.status_code in STATUSES_KNOWN
            assert self.model.accounts.get(account.id) is account

            self._question_finished(
                run,
                owner=owner,
                question_id=question_id,
                tokens=tokens,
                response=response,
            )

        def reconcile() -> None:
            assert self.world.faults is not None
            assert owner is None or any(item.question_id == question_id for item in owner.questions)

            if owner is None:
                return

            for question in owner.questions:
                if question.question_id == question_id:
                    if not question.finished:
                        stored = AccountQuestion.objects.get(pk=question_id)

                        if stored.finished_datetime is not None:
                            question.finished = True
                            question.tokens = tokens

        exchange = Exchange('question finish', reconcile, retried=True, send=send, settle=settle)

        self._exchange(run, exchange)

    def _question_target(self, run: Run, account: AccountModel) -> tuple[int, AccountModel | None]:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert self.model.accounts.get(account.id) is account

        own = [question.question_id for question in account.questions]

        other_accounts = [
            other
            for other in self.model.accounts.values()
            if other.questions
            if other.id != account.id
        ]

        choice = run.rng.random()

        if own:
            if choice < 0.75:
                return run.rng.choice(own), account

        if other_accounts:
            if choice < 0.85:
                other = run.rng.choice(other_accounts)
                return run.rng.choice(other.questions).question_id, None

        return run.rng.choice([QUESTION_ID_UNKNOWN, *QUESTION_IDS_INVALID]), None

    def _question_finished(
        self,
        run: Run,
        *,
        owner: AccountModel | None,
        question_id: int,
        tokens: int,
        response: Response,
    ) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert owner is None or any(item.question_id == question_id for item in owner.questions)
        assert question_id > 0 or question_id in QUESTION_IDS_INVALID
        assert tokens > 0 or tokens in QUESTION_TOKENS_INVALID
        assert response.status_code in STATUSES_KNOWN

        if question_id <= 0:
            _expected_check(response, Expected('question_unknown', '', 404), 'question finish')
            return

        if not 0 < tokens <= 1_000_000:
            _expected_check(response, Expected('request_invalid', '', 400), 'question finish')
            return

        if owner is None:
            _expected_check(response, Expected('question_unknown', '', 404), 'question finish')
            run.sometimes('question finish of another account refused')
            return

        question = next(item for item in owner.questions if item.question_id == question_id)

        _expected_check(response, Expected('', '', 200), 'question finish')

        run.sometimes('question finished again', condition=question.finished)

        if not question.finished:
            question.finished = True
            question.tokens = tokens

        if _body(response) != {'question_id': question_id, 'tokens': question.tokens}:
            invariant_violated(f'question finish answered {_body(response)}, model {question}')

    def click(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        campaign = run.rng.choice([*CAMPAIGNS_DECLARED, *CAMPAIGNS_DECLARED, CAMPAIGN_UNDECLARED])
        page = run.rng.choice([*PAGES_DECLARED, *PAGES_DECLARED, 'pricing'])
        fields = {'campaign': campaign, 'page': page}
        declared = campaign in CAMPAIGNS_DECLARED and page in PAGES_DECLARED
        valid = declared and (page == 'landing') == (campaign == 'general')

        def send() -> Response:
            return self._beacon(FUNNEL_CLICK_PATH, fields)

        def settle(response: Response) -> None:
            assert response.status_code in STATUSES_KNOWN

            expected = Expected('', '', 204) if valid else Expected('request_invalid', '', 400)

            _expected_check(response, expected, 'click')

            run.sometimes('click counted', condition=valid)
            run.sometimes('click refused outside its campaign', condition=declared and not valid)

            if not valid:
                return

            if campaign == 'general':
                self.model.metric_add('remi:acquisition:click:landing')
            else:
                self.model.metric_add(f'remi:acquisition:click:{campaign}:promo')

        exchange = Exchange('click', lambda: None, retried=False, send=send, settle=settle)

        self._exchange(run, exchange)

    def download(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        campaign = run.rng.choice([*CAMPAIGNS_DECLARED, *CAMPAIGNS_DECLARED, CAMPAIGN_UNDECLARED])
        platform = run.rng.choice([*PLATFORMS_DECLARED, *PLATFORMS_DECLARED, 'beos'])
        personal = [promo.code for promo in self.model.promos.values() if promo.email != '']
        personal_lower = [code.lower() for code in personal]
        codes = ['', '', 'WIB2026', 'NOSUCHCODE', 'two words', *personal, *personal_lower]
        code = run.rng.choice(codes)
        fields = {'campaign': campaign, 'platform': platform, 'code': code}
        declared = campaign in CAMPAIGNS_DECLARED and platform in PLATFORMS_DECLARED
        valid = declared and code != 'two words'

        def send() -> Response:
            return self._beacon(FUNNEL_DOWNLOAD_PATH, fields)

        def settle(response: Response) -> None:
            assert response.status_code in STATUSES_KNOWN

            expected = Expected('', '', 204) if valid else Expected('request_invalid', '', 400)

            _expected_check(response, expected, 'download')

            if not valid:
                return

            self.model.download_record(campaign=campaign, platform=platform)
            promo = self.model.promo_find(code) if code != '' else None

            if promo is None:
                return

            if promo.email != '':
                run.sometimes('download stamped a personal code', condition=not promo.downloaded)
                promo.downloaded = True

        def reconcile() -> None:
            assert self.world.faults is not None

            if valid:
                self.model.download_record(campaign=campaign, platform=platform)

            promo = self.model.promo_find(code) if code != '' else None

            if promo is None:
                return

            if promo.email != '':
                if not promo.downloaded:
                    stored = PromoCode.objects.get(code=promo.code)
                    promo.downloaded = stored.downloaded_datetime is not None

        exchange = Exchange('download', reconcile, retried=False, send=send, settle=settle)

        self._exchange(run, exchange)

    def email(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert not self.world.sendgrid.fault_next

        address_raw = run.rng.choice(EMAILS_VALID + EMAILS_VALID + EMAILS_INVALID)
        address = run.rng.choice([address_raw, f' {address_raw}  '])
        campaign = run.rng.choice([*CAMPAIGNS_DECLARED, 'wib', CAMPAIGN_UNDECLARED])
        fields = {'campaign': campaign, 'email': address}
        fault = self.world.faults is not None and self.world.faults.sendgrid_roll(run.rng)
        known_codes = set(self.model.promos)

        def send() -> Response:
            assert not self.world.sendgrid.fault_next
            assert known_codes == self.model.promos.keys()

            self.world.sendgrid.fault_next = fault
            return self._beacon(FUNNEL_EMAIL_PATH, fields)

        def settle(response: Response) -> None:
            assert response.status_code in STATUSES_KNOWN
            assert known_codes == self.model.promos.keys()

            self.world.sendgrid.fault_next = False

            self._email_settled(
                run,
                address=address.strip(),
                campaign=campaign,
                fault=fault,
                response=response,
            )

        def reconcile() -> None:
            assert self.world.faults is not None

            self.world.sendgrid.fault_next = False
            self._personal_codes_discover(known_codes)

        exchange = Exchange('email', reconcile, retried=False, send=send, settle=settle)

        self._exchange(run, exchange)

    def _email_settled(
        self,
        run: Run,
        *,
        address: str,
        campaign: str,
        fault: bool,
        response: Response,
    ) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert address == address.strip()
        assert campaign in CAMPAIGNS_DECLARED or campaign == CAMPAIGN_UNDECLARED
        assert response.status_code in STATUSES_KNOWN

        valid = campaign in CAMPAIGNS_DECLARED and address in EMAILS_VALID

        if not valid:
            _expected_check(response, Expected('request_invalid', '', 400), 'email')
            return

        shared = self.model.promos['WIB2026']

        if campaign == 'wib':
            if not shared.is_active:
                message = 'The conference offer is not set up on the server yet.'
                _expected_check(response, Expected('email_unavailable', message, 503), 'email')
                run.sometimes('email refused while the offer is off')
                return

        code = ''

        if campaign == 'wib':
            promos_count = len(self.model.promos)
            early_codes_issued = shared.early_codes_issued
            code = self._personal_code_settle(address, shared)
            issued = len(self.model.promos) > promos_count
            early = shared.early_codes_issued > early_codes_issued
            spent = shared.early_codes_max > 0 and not early

            run.sometimes('email issued an early code', condition=early)

            run.sometimes(
                'email issued a shared-hours code after the early codes',
                condition=issued and spent,
            )

        self._email_window_settle(
            run,
            address=address,
            campaign=campaign,
            code=code,
            fault=fault,
            response=response,
        )

    def _personal_code_settle(self, address: str, shared: PromoModel) -> str:
        assert address in EMAILS_VALID
        assert shared.campaign == 'wib'
        assert shared.email == ''

        for promo in self.model.promos.values():
            if promo.email.casefold() == address.casefold():
                if promo.campaign == 'wib':
                    return promo.code

        stored = PromoCode.objects.issued().by_campaign('wib').by_email(address).get()

        promo = PromoModel(
            campaign='wib',
            code=stored.code,
            email=address,
            hours=shared.issue_hours_take(),
            redemptions_max=1,
        )

        self.model.promos[stored.code.upper()] = promo
        self.model.lead_record(promo.campaign)

        return stored.code

    def _email_window_settle(
        self,
        run: Run,
        *,
        address: str,
        campaign: str,
        code: str,
        fault: bool,
        response: Response,
    ) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert address in EMAILS_VALID
        assert campaign in CAMPAIGNS_DECLARED
        assert (code != '') == (campaign == 'wib')
        assert response.status_code in STATUSES_KNOWN

        now = timezone.now()
        key = address.casefold()
        sent_at = self.model.address_sent_at.get(key)

        if sent_at is not None:
            if now - sent_at < timedelta(seconds=3600):
                _expected_check(response, Expected('', '', 204), 'email')
                run.sometimes('email held by the address window')
                return

        day = timezone.localdate().isoformat()
        self.model.email_day_counts[day] += 1

        if self.model.email_day_counts[day] > EMAIL_DAY_COUNT_MAX:
            message = 'The server has sent all the email it sends in a day.'
            _expected_check(response, Expected('email_unavailable', message, 503), 'email')
            run.sometimes('email held by the daily cap')
            return

        if fault:
            message = 'The email did not send. Try again in a minute.'
            _expected_check(response, Expected('email_unavailable', message, 503), 'email')
            run.sometimes('email SendGrid fault')
            return

        _expected_check(response, Expected('', '', 204), 'email')

        self.model.address_sent_at[key] = now
        record = EmailModel(address=address, campaign=campaign, code=code, sent_at=now)
        self.model.emails.append(record)

        run.sometimes('email sent with a personal code', condition=code != '')

    def _personal_codes_discover(self, known_codes: set[str]) -> None:
        assert self.world.faults is not None
        assert known_codes == self.model.promos.keys()

        shared = self.model.promos['WIB2026']
        stored = PromoCode.objects.issued().exclude(code__in=list(known_codes))

        for promo in stored.order_by('pk'):
            hours = shared.issue_hours_take()

            if promo.hours != hours:
                message = f'personal code {promo.code} carries {promo.hours} hours, not {hours}'
                raise AssertionError(message)

            self.model.promos[promo.code.upper()] = PromoModel(
                campaign=promo.campaign,
                code=promo.code,
                email=promo.email,
                hours=hours,
                redemptions_max=1,
            )

            self.model.lead_record(promo.campaign)

    def complimentary_start(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        account = self._account_any(run)

        if account is None:
            return

        reference = f'topup:simulation:{run.step}:{account.id}'

        assert reference not in account.grants

        stored = Account.objects.get(pk=account.id)
        granted = stored.services.processor.complimentary_start(reference=reference)
        expected = self.model.topup_apply(account, reference)
        account.complimentary = True

        assert account.balance >= TOPUP_BALANCE_SECONDS

        if granted != expected:
            invariant_violated(f'complimentary start granted {granted}, the model {expected}')

        run.sometimes('complimentary topped up', condition=granted > 0)

    def complimentary_end(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        account = self._account_any(run)

        if account is None:
            return

        Account.objects.get(pk=account.id).services.processor.complimentary_end()
        account.complimentary = False

    def token_issue(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        account = self._account_any(run)

        if account is None:
            return

        token = Account.objects.get(pk=account.id).services.processor.token_issue()

        assert token != account.token
        assert token not in account.tokens_retired

        if account.token is not None:
            account.tokens_retired.append(account.token)

        account.token = token
        account.token_hash = token_digest(token)

        run.sometimes('sign-in code reissued')

    def _account_any(self, run: Run) -> AccountModel | None:
        assert 0 <= run.step < STEP_COUNT_MAX

        if not self.model.accounts:
            run.log('no account')

            return None

        return self.model.accounts[run.rng.choice(sorted(self.model.accounts))]

    def promo_create(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        code = f'GIFT{run.step}'
        hours = run.rng.randint(1, 8)
        redemptions_max = run.rng.randint(0, 4)

        assert code not in self.model.promos

        promo = PromoCode(
            campaign='general',
            code=code,
            hours=hours,
            redemptions_max=redemptions_max,
        )

        promo.services.save_model_obj()

        self.model.promos[code] = PromoModel(
            campaign='general',
            code=code,
            email='',
            hours=hours,
            redemptions_max=redemptions_max,
        )

    def promo_toggle(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        shared = [promo for promo in self.model.promos.values() if promo.email == '']

        assert shared

        promo = run.rng.choice(shared)
        is_active = run.rng.random() < 0.7

        PromoCode.objects.get(code=promo.code).services.processor.active_set(is_active=is_active)
        promo.is_active = is_active

        run.log(f'promo {promo.code} active={is_active}')

    def promo_terms(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        shared = [promo for promo in self.model.promos.values() if promo.email == '']

        assert shared

        promo = run.rng.choice(shared)
        hours = run.rng.randint(1, 60)
        redemptions_max = run.rng.randint(0, 15)
        early_codes_max = run.rng.randint(0, 3)
        early_hours = run.rng.randint(1, 80)
        stored = PromoCode.objects.get(code=promo.code)

        stored.services.processor.terms_save(
            campaign=promo.campaign,
            hours=hours,
            redemptions_max=redemptions_max,
        )

        stored.services.processor.early_save(
            early_codes_max=early_codes_max,
            early_hours=early_hours,
        )

        promo.hours = hours
        promo.redemptions_max = redemptions_max
        promo.early_codes_max = early_codes_max
        promo.early_hours = early_hours

    def idle(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        seconds = run.rng.choice(IDLE_SECONDS_CHOICES)
        before = run.clock.now()

        run.clock.advance(seconds)
        run.log(f'idle {seconds} seconds')

        after = run.clock.now()

        assert after - before == timedelta(seconds=seconds)

    def invariants(self) -> tuple[Callable[[Run], None], ...]:
        return (
            self.invariant_database_matches_model,
            self.invariant_balances_never_negative,
            self.invariant_tokens_sign_in_only_their_account,
            self.invariant_ask_pacing_held,
            self.invariant_emails_respect_the_address_window,
            self.invariant_purchases_only_from_paid_remi_sessions,
            self.invariant_payments_match_their_sessions,
            self.invariant_rows_clean,
        )

    def invariant_rows_clean(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        if run.step % ROWS_CHECK_EVERY_STEPS != ROWS_CHECK_EVERY_STEPS - 1:
            return

        self.rows_clean(run)

    def invariant_database_matches_model(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        database = snapshot_database(self.world.metric)
        model = snapshot_model(self.model)

        assert database.keys() == model.keys()

        for section, observed in database.items():
            if observed != model[section]:
                invariant_violated(
                    f'{section} drifted from the model:\n'
                    f'  database {observed}\n'
                    f'  model    {model[section]}',
                )

    def invariant_balances_never_negative(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        for account in Account.objects.with_balance().order_by('pk'):
            if account.balance_seconds < 0:
                invariant_violated(f'account {account.pk} holds {account.balance_seconds} seconds')

    def invariant_tokens_sign_in_only_their_account(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert all(item.token not in item.tokens_retired for item in self.model.accounts.values())

        if run.step % TOKEN_CHECK_EVERY_STEPS != TOKEN_CHECK_EVERY_STEPS - 1:
            return

        for account in self.model.accounts.values():
            for token in [account.token, *account.tokens_retired]:
                if token is None:
                    continue

                headers = {'Authorization': f'Bearer {token}'}
                response = self.world.client.get(ACCOUNT_PATH, headers=headers)
                current = token == account.token

                if (response.status_code == 200) != current:
                    invariant_violated(f'token of {account.id} answered {response.status_code}')

                if current:
                    if _body(response)['email'] != account.email:
                        invariant_violated(f'token of {account.id} signed in as {_body(response)}')

    def invariant_ask_pacing_held(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX

        limits = self.model.limits
        burst = timedelta(seconds=limits.burst_seconds)
        pace = timedelta(seconds=limits.pace_seconds)

        assert limits.burst_count > 0

        for account in self.model.accounts.values():
            asked = sorted(question.asked for question in account.questions)

            for index, moment in enumerate(asked):
                inside = [other for other in asked[: index + 1] if moment - other < burst]

                if len(inside) > limits.burst_count:
                    invariant_violated(f'{account.id} asked {len(inside)} questions in one burst')

            ordered = sorted(account.questions, key=lambda question: question.asked)

            for previous, question in itertools.pairwise(ordered):
                if question.tokens_window_before >= limits.tokens_soft_cap:
                    if question.asked - previous.asked < pace:
                        invariant_violated(f'{account.id} asked past the soft cap without the pace')

    def invariant_emails_respect_the_address_window(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert len(self.world.sendgrid.delivered) <= len(self.world.sendgrid.requests)

        sent_last: dict[str, float] = {}

        for recipient, sent_at in self.world.sendgrid.delivered:
            key = recipient.casefold()
            previous = sent_last.get(key)

            if previous is not None:
                if sent_at - previous < 3600:
                    invariant_violated(f'{recipient} was emailed twice within the hour')

            sent_last[key] = sent_at

        if len(self.world.sendgrid.delivered) != len(self.model.emails):
            invariant_violated(
                f'{len(self.world.sendgrid.delivered)} emails delivered, '
                f'the model sent {len(self.model.emails)}',
            )

    def invariant_payments_match_their_sessions(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert self.model.sessions.keys() <= self.world.stripe.sessions.keys()

        purchases = AccountLedgerEntry.objects.purchases().select_related('payment').order_by('pk')

        for entry in purchases:
            payment = entry.payment
            session = self.world.stripe.sessions.get(entry.reference)

            if payment is None:
                invariant_violated(f'purchase {entry.pk} names no payment')

            if session is None:
                invariant_violated(f'purchase {entry.pk} names unknown session {entry.reference}')

            metadata = session.metadata.to_dict()

            stored = (
                payment.account_id,
                payment.amount_cents,
                payment.currency,
                payment.seconds,
                payment.stripe_checkout_session_id,
                payment.stripe_payment_intent_id,
            )

            charged = (
                int(metadata['account_id']),
                session.amount_total,
                session.currency,
                int(metadata['seconds']),
                session.id,
                session.payment_intent,
            )

            if stored != charged:
                invariant_violated(f'purchase {entry.pk} stored {stored}, Stripe took {charged}')

    def invariant_purchases_only_from_paid_remi_sessions(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert all(session.owned for session in self.model.sessions.values() if session.credited)

        for entry in AccountLedgerEntry.objects.purchases().order_by('pk'):
            session = self.world.stripe.sessions.get(entry.reference)

            if session is None:
                invariant_violated(f'purchase {entry.pk} names unknown session {entry.reference}')

            if session.payment_status != 'paid':
                invariant_violated(f'purchase {entry.pk} credited unpaid {entry.reference}')

            if session.metadata.to_dict().get('app') != 'remi':
                invariant_violated(f'purchase {entry.pk} credited another app {entry.reference}')


def _webhook_session_expected(session: SessionModel) -> Expected:
    assert session.owned or session.paid
    assert session.paid or not session.credited

    if not session.owned:
        return Expected('foreign', '', 200)

    if not session.paid:
        return Expected('unpaid', '', 200)

    return Expected('credit', '', 200)


def account_entry(*, account_id: int, kind: str, reference: str) -> AccountLedgerEntry | None:
    assert account_id > 0
    assert kind in AccountLedgerEntryKindChoices.values
    assert reference != ''

    entries = AccountLedgerEntry.objects.filter(account_id=account_id, kind=kind)
    return entries.by_reference(reference).first()


def snapshot_database(metric: MetricExecutorFake) -> dict[str, object]:
    assert all(dispatch.value > 0 for dispatch in metric.dispatched)
    assert all(dispatch.sub_domain_key == 'remi--metrics' for dispatch in metric.dispatched)

    accounts = sorted(
        (
            account.pk,
            account.email,
            account.name,
            account.campaign,
            account.region,
            account.is_complimentary,
            account.token_hash,
        )
        for account in Account.objects.all()
    )

    entries = sorted(
        AccountLedgerEntry.objects.values_list('account_id', 'kind', 'reference', 'seconds'),
    )

    questions = sorted(
        (
            question.account_id,
            question.pk,
            question.tokens,
            question.finished_datetime is not None,
        )
        for question in AccountQuestion.objects.all()
    )

    promos = sorted(
        (
            promo.code,
            promo.campaign,
            promo.email.casefold(),
            promo.hours,
            promo.redemptions_max,
            promo.early_codes_issued,
            promo.early_codes_max,
            promo.early_hours,
            promo.is_active,
            promo.downloaded_datetime is not None,
        )
        for promo in PromoCode.objects.all()
    )

    counts: Counter[Metric] = Counter()
    sums: dict[Metric, Decimal] = {}

    for dispatch in metric.dispatched:
        key = Metric(reference=dispatch.reference, statistic=dispatch.statistic_key)

        counts[key] += 1
        sums[key] = sums.get(key, Decimal(0)) + dispatch.value

    return {
        'accounts': accounts,
        'entries': entries,
        'metric_counts': dict(counts),
        'metric_sums': sums,
        'promos': promos,
        'questions': questions,
    }


def snapshot_model(model: WorldModel) -> dict[str, object]:
    assert all(account.id == key for key, account in model.accounts.items())
    assert all(promo.code.upper() == key for key, promo in model.promos.items())

    accounts = sorted(
        (
            account.id,
            account.email,
            account.name,
            account.campaign,
            account.region,
            account.complimentary,
            account.token_hash,
        )
        for account in model.accounts.values()
    )

    entries: list[tuple[int, str, str, int]] = []

    for account in model.accounts.values():
        charges = [(job, -seconds) for job, seconds in account.charges.items()]

        entries.extend((account.id, 'charge', job, seconds) for job, seconds in charges)
        entries.extend((account.id, 'grant', *grant) for grant in account.grants.items())
        entries.extend((account.id, 'promo', *promo) for promo in account.promos.items())
        purchases = account.purchases.items()

        entries.extend((account.id, 'purchase', *purchase) for purchase in purchases)

    questions = sorted(
        (account.id, question.question_id, question.tokens, question.finished)
        for account in model.accounts.values()
        for question in account.questions
    )

    promos = sorted(
        (
            promo.code,
            promo.campaign,
            promo.email.casefold(),
            promo.hours,
            promo.redemptions_max,
            promo.early_codes_issued,
            promo.early_codes_max,
            promo.early_hours,
            promo.is_active,
            promo.downloaded,
        )
        for promo in model.promos.values()
    )

    return {
        'accounts': accounts,
        'entries': sorted(entries),
        'metric_counts': dict(model.metric_counts),
        'metric_sums': dict(model.metric_sums),
        'promos': promos,
        'questions': questions,
    }


def email_day_cap_install(monkeypatch: pytest.MonkeyPatch) -> None:
    assert funnel_mail.FUNNEL_EMAIL_DAY_COUNT_MAX >= EMAIL_DAY_COUNT_MAX

    monkeypatch.setattr(funnel_mail, 'FUNNEL_EMAIL_DAY_COUNT_MAX', EMAIL_DAY_COUNT_MAX)
