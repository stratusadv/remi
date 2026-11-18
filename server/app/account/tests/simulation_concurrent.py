from __future__ import annotations

import copy
import itertools
import time

from dataclasses import dataclass
from typing_extensions import TYPE_CHECKING, NamedTuple

from django.test import Client
from django.utils import timezone

from app.account.models import Account
from app.account.tests.simulation_engine import (
    STATUSES_KNOWN,
    RemiWorld,
    snapshot_database,
    snapshot_model,
)
from app.account.tests.simulation_model import (
    AccountModel,
    PromoModel,
    QuestionModel,
    SessionModel,
    token_digest,
)
from app.promo_code.models import PromoCode
from harness.api import (
    ACCOUNT_CHARGE_PATH,
    ACCOUNT_CHECKOUT_FINISH_PATH,
    ACCOUNT_PROMO_PATH,
    ACCOUNT_QUESTION_PATH,
    STRIPE_EVENT_PATH,
)
from harness.simulation.interleaver import Interleaver
from harness.simulation.invariant import invariant_violated
from harness.simulation.run import STEP_COUNT_MAX
from harness.stripe import STRIPE_WEBHOOK_SECRET, stripe_event_payload, stripe_signature_header

if TYPE_CHECKING:
    from collections.abc import Callable

    from django.test.client import _MonkeyPatchedWSGIResponse

    from app.account.tests.simulation_model import WorldModel
    from harness.simulation.run import Run


ACCOUNT_EMAILS = ('avery@example.com', 'avery@example.com', 'morgan@example.com')
ACCOUNT_REGION = 'CA-AB'
ACTOR_COUNT_MAX = 3
ACTOR_COUNT_MIN = 2
CHARGE_SECONDS_CHOICES = (1800, 3600, 5400)

JOB_IDS = (
    '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
    '1f2e3d4c5b6a79880716253443526170',
    '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b',
)

OPERATION_KINDS = ('charge', 'complimentary', 'finish', 'promo', 'question', 'webhook')
PROMO_CODES_CONTESTED = ('DUO', 'TRIO', 'WIB2026')
SEED_HOURS = 2
SESSION_HOURS = 50

PROMOS_CONTESTED = (
    PromoModel(campaign='general', code='DUO', email='', hours=3, redemptions_max=1),
    PromoModel(campaign='general', code='TRIO', email='', hours=1, redemptions_max=2),
    PromoModel(campaign='wib', code='WIB2026', email='', hours=4, redemptions_max=10),
    PromoModel(campaign='general', code='SEED', email='', hours=SEED_HOURS, redemptions_max=3),
)


class Outcome(NamedTuple):
    code: str
    detail: object
    status: int


@dataclass(frozen=True)
class Operation:
    account_pk: int
    argument: str
    kind: str
    seconds: int = 0


def _outcome_of(response: _MonkeyPatchedWSGIResponse) -> Outcome:
    assert response.status_code in STATUSES_KNOWN

    code = ''
    detail: object = None

    if response.status_code >= 400:
        if response['Content-Type'].startswith('application/json'):
            code = response.json()['error']['code']

    if response.status_code == 200:
        if response['Content-Type'].startswith('application/json'):
            detail = response.json().get('question_id')

    assert isinstance(code, str)
    assert detail is None or isinstance(detail, int)

    return Outcome(code=code, detail=detail, status=response.status_code)


class RemiConcurrency:
    def __init__(self, world: RemiWorld) -> None:
        assert world.faults is None
        assert not world.model.accounts

        self.world = world
        self.model = world.model

    def setup(self, run: Run) -> None:
        assert run.step == 0
        assert not self.model.accounts

        for shared in PROMOS_CONTESTED:
            promo = PromoCode(
                campaign=shared.campaign,
                code=shared.code,
                hours=shared.hours,
                redemptions_max=shared.redemptions_max,
            )

            promo.services.save_model_obj()
            self.model.promos[shared.code] = copy.copy(shared)

        for index, email in enumerate(ACCOUNT_EMAILS):
            self._account_seed(email=email, name=f'Actor {index}')

        for account in list(self.model.accounts.values()):
            self._session_seed(account, paid=True)
            self._session_seed(account, paid=False)

        assert len(self.model.accounts) == len(ACCOUNT_EMAILS)
        assert len(self.model.sessions) == 2 * len(ACCOUNT_EMAILS)

        run.log(f'accounts={sorted(self.model.accounts)} sessions={sorted(self.model.sessions)}')

    def _account_seed(self, *, email: str, name: str) -> None:
        assert email in ACCOUNT_EMAILS
        assert name == name.strip()
        assert name != ''

        stored, token = Account.services.factory.create(
            email=email,
            name=name,
            promo_code='',
            region=ACCOUNT_REGION,
        )

        account = AccountModel(
            campaign='general',
            email=email,
            id=stored.pk,
            name=name,
            region=ACCOUNT_REGION,
            token=token,
            token_hash=token_digest(token),
        )

        self.model.accounts[account.id] = account

        self.model.metric_add(campaign='general', statistic='remi--funnel--signups')

        if self.model.promo_refusal(account_email=email, code='SEED') is None:
            stored.services.processor.promo_redeem('SEED')
            self.model.promo_apply(account, 'SEED')

    def _session_seed(self, account: AccountModel, *, paid: bool) -> None:
        assert self.model.accounts.get(account.id) is account
        assert SESSION_HOURS in self.model.offers

        stored = Account.objects.get(pk=account.id)

        session = stored.services.checkout.session_create(
            hours=SESSION_HOURS,
            return_url='https://api.example.test/checkout/return/',
        )

        assert session.id not in self.model.sessions

        self.model.sessions[session.id] = SessionModel(
            account_pk=account.id,
            amount_cents=self.model.offers[SESSION_HOURS],
            hours=SESSION_HOURS,
            owned=True,
            paid=paid,
            session_id=session.id,
        )

        self.model.metric_add(campaign=account.campaign, statistic='remi--funnel--checkouts')

        if paid:
            self.world.stripe.pay(session.id)

    def step(self, run: Run) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert self.model.accounts

        count = run.rng.randint(ACTOR_COUNT_MIN, ACTOR_COUNT_MAX)
        operations = [self._operation_pick(run) for _ in range(count)]
        actors = [self._actor(operation) for operation in operations]

        described = [(op.kind, op.account_pk, op.argument) for op in operations]

        run.log(f'concurrent {described}')

        results, errors = Interleaver(run.rng, actors).drive()

        if errors:
            invariant_violated(f'concurrent actors raised {errors!r} for {operations}')

        outcomes: list[Outcome] = []

        for index in range(count):
            outcome = results.get(index)

            if not isinstance(outcome, Outcome):
                invariant_violated(f'actor {index} answered {outcome!r} for {operations[index]}')

            outcomes.append(outcome)

        self._serialization_adopt(run, operations, outcomes)

    def _operation_pick(self, run: Run) -> Operation:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert self.model.accounts

        account_pk = run.rng.choice(sorted(self.model.accounts))
        kinds = ['charge', 'charge', 'promo', 'finish', 'webhook', 'question', 'complimentary']
        kind = run.rng.choice(kinds)

        if kind == 'charge':
            seconds = run.rng.choice(CHARGE_SECONDS_CHOICES)
            return Operation(account_pk, run.rng.choice(JOB_IDS), kind, seconds)

        if kind == 'promo':
            return Operation(account_pk, run.rng.choice(PROMO_CODES_CONTESTED), kind)

        if kind in {'finish', 'webhook'}:
            own = [
                session.session_id
                for session in self.model.sessions.values()
                if session.account_pk == account_pk
            ]

            return Operation(account_pk, run.rng.choice(own), kind)

        if kind == 'complimentary':
            reference = f'topup:concurrent:{run.step}:{run.rng.getrandbits(32)}'
            return Operation(account_pk, reference, kind)

        return Operation(account_pk, '', kind)

    def _actor(self, operation: Operation) -> Callable[[], Outcome]:
        assert operation.kind in OPERATION_KINDS
        assert operation.account_pk in self.model.accounts

        account = self.model.accounts[operation.account_pk]
        token = account.token or ''

        def act() -> Outcome:
            assert token != ''

            client = Client()
            headers = {'Authorization': f'Bearer {token}'}

            if operation.kind == 'complimentary':
                stored = Account.objects.get(pk=operation.account_pk)
                processor = stored.services.processor
                granted = processor.complimentary_start(reference=operation.argument)

                return Outcome(code='', detail=granted, status=200)

            if operation.kind == 'webhook':
                payload = stripe_event_payload(
                    event_type='checkout.session.completed',
                    session_id=operation.argument,
                )

                timestamp = int(time.time())
                signature = stripe_signature_header(
                    payload,
                    secret=STRIPE_WEBHOOK_SECRET,
                    timestamp=timestamp,
                )

                webhook_headers = {'Stripe-Signature': signature}

                response = client.post(
                    STRIPE_EVENT_PATH,
                    data=payload,
                    content_type='application/json',
                    headers=webhook_headers,
                )

                return Outcome(code='', detail=None, status=response.status_code)

            path, body = self._request_of(operation)

            response = client.post(
                path,
                data=body,
                content_type='application/json',
                headers=headers,
            )

            return _outcome_of(response)

        act.__qualname__ = f'{operation.kind}:{operation.account_pk}'
        return act

    def _request_of(self, operation: Operation) -> tuple[str, dict[str, object]]:
        assert operation.kind in OPERATION_KINDS
        assert (operation.seconds > 0) == (operation.kind == 'charge')

        if operation.kind == 'charge':
            return ACCOUNT_CHARGE_PATH, {'job_id': operation.argument, 'seconds': operation.seconds}

        if operation.kind == 'promo':
            return ACCOUNT_PROMO_PATH, {'code': operation.argument}

        if operation.kind == 'finish':
            return ACCOUNT_CHECKOUT_FINISH_PATH, {'session_id': operation.argument}

        if operation.kind == 'question':
            return ACCOUNT_QUESTION_PATH, {}

        message = f'no request for {operation.kind}'
        raise ValueError(message)

    def _serialization_adopt(
        self,
        run: Run,
        operations: list[Operation],
        outcomes: list[Outcome],
    ) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert ACTOR_COUNT_MIN <= len(operations) <= ACTOR_COUNT_MAX
        assert len(outcomes) == len(operations)

        database = snapshot_database(self.world.metric)

        for order in itertools.permutations(range(len(operations))):
            candidate = copy.deepcopy(self.model)

            predicted = {
                index: _replay(candidate, operations[index], outcomes[index])
                for index in order
            }

            if any(predicted[index] != outcomes[index] for index in order):
                continue

            if snapshot_model(candidate) != database:
                continue

            self._model_adopt(candidate)
            run.sometimes('concurrent actors serialized', condition=len(operations) > 1)
            self._sometimes_note(run, operations, outcomes)

            return

        invariant_violated(
            f'no serial order of {operations} explains the answers {outcomes} '
            f'and the database {database}',
        )

    def _model_adopt(self, candidate: WorldModel) -> None:
        assert candidate is not self.model
        assert candidate.accounts.keys() == self.model.accounts.keys()

        self.model.accounts = candidate.accounts
        self.model.metric_counts = candidate.metric_counts
        self.model.metric_sums = candidate.metric_sums
        self.model.promos = candidate.promos
        self.model.sessions = candidate.sessions
        self.world.model = self.model

    def _sometimes_note(
        self,
        run: Run,
        operations: list[Operation],
        outcomes: list[Outcome],
    ) -> None:
        assert 0 <= run.step < STEP_COUNT_MAX
        assert len(outcomes) == len(operations)

        kinds = [operation.kind for operation in operations]
        same_account = len({operation.account_pk for operation in operations}) == 1
        refused = [outcome for outcome in outcomes if outcome.status >= 400]

        charges_raced = kinds.count('charge') > 1 and same_account

        run.sometimes('charges raced on one account', condition=charges_raced)
        run.sometimes('promo raced', condition=kinds.count('promo') > 1)
        run.sometimes('finish raced a webhook', condition='finish' in kinds and 'webhook' in kinds)
        run.sometimes('a racer was refused', condition=bool(refused))


def _replay(model: WorldModel, operation: Operation, observed: Outcome) -> Outcome:
    assert operation.account_pk in model.accounts
    assert operation.kind in OPERATION_KINDS
    assert observed.status in STATUSES_KNOWN

    account = model.accounts[operation.account_pk]

    if operation.kind == 'charge':
        return _replay_charge(model, account, operation)

    if operation.kind == 'promo':
        refusal = model.promo_refusal(account_email=account.email, code=operation.argument)

        if refusal is not None:
            return Outcome(code=refusal.code, detail=None, status=refusal.status)

        model.promo_apply(account, operation.argument)

        return Outcome(code='', detail=None, status=200)

    if operation.kind in {'finish', 'webhook'}:
        session = model.sessions[operation.argument]

        if session.paid:
            model.purchase_apply(session)

        return Outcome(code='', detail=None, status=200)

    if operation.kind == 'complimentary':
        granted = model.topup_apply(account, operation.argument)
        account.complimentary = True

        return Outcome(code='', detail=granted, status=200)

    return _replay_question(model, account, observed)


def _replay_charge(model: WorldModel, account: AccountModel, operation: Operation) -> Outcome:
    assert model.accounts.get(account.id) is account
    assert operation.kind == 'charge'

    expected = model.charge_expected(account, operation.argument, operation.seconds)

    if expected.status == 200:
        model.charge_apply(account, operation.argument, operation.seconds)

    return Outcome(code=expected.code, detail=None, status=expected.status)


def _replay_question(model: WorldModel, account: AccountModel, observed: Outcome) -> Outcome:
    assert model.accounts.get(account.id) is account
    assert observed.status in STATUSES_KNOWN

    now = timezone.now()

    if not model.ask_active(account, now):
        return Outcome(code='ask_inactive', detail=None, status=403)

    pace = model.ask_pace_expected(account, now)

    if pace.wait_seconds > 0:
        return Outcome(code='', detail=None, status=200)

    if not isinstance(observed.detail, int):
        return Outcome(code='', detail='admitted', status=200)

    _, usage = model.ask_usage(account, now)

    question = QuestionModel(
        asked=now,
        finished=False,
        question_id=observed.detail,
        tokens=model.limits.tokens_estimate,
        tokens_window_before=usage.tokens,
    )

    account.questions.append(question)

    return Outcome(code='', detail=observed.detail, status=200)
