from __future__ import annotations

import pytest

from typing_extensions import TYPE_CHECKING

from harness.world.client import (
    address_unique,
    fakes_control,
    fakes_state,
    remi_get,
    remi_post,
    remi_signup,
)

if TYPE_CHECKING:
    from harness.world.world import World


CHECKOUT_FINISH_PATH = '/api/v1/account/checkout/finish/'
CHECKOUT_PATH = '/api/v1/account/checkout/'
PACK_HOURS = 10
PACK_SECONDS = PACK_HOURS * 3600

pytestmark = pytest.mark.system


def test_a_checkout_through_the_stripe_sdk_sends_the_pack_and_credits_it_once(
    world_live: World,
) -> None:
    address = address_unique('checkout')
    token = remi_signup(world_live, email=address)
    started = remi_post(world_live, CHECKOUT_PATH, {'hours': PACK_HOURS}, token=token)
    session_id = started.json()['session_id']
    session = next(item for item in fakes_state(world_live)['sessions'] if item['id'] == session_id)

    assert started.status == 200
    assert started.json()['client_secret'] == f'{session_id}_secret_world'
    assert session['amount_total'] == 1000
    assert session['currency'] == 'cad'
    assert session['customer_email'] == address
    assert session['metadata']['app'] == 'remi'
    assert session['metadata']['seconds'] == str(PACK_SECONDS)
    assert session['mode'] == 'payment'
    assert session['return_url'] == f'{world_live.descriptor["remi_url"]}/checkout/return/'
    assert session['ui_mode'] == 'elements'

    finish = {'session_id': session_id}
    unpaid = remi_post(world_live, CHECKOUT_FINISH_PATH, finish, token=token)

    assert unpaid.json()['paid'] is False
    assert unpaid.json()['account']['balance_seconds'] == 0

    paid = fakes_control(world_live, '/control/stripe/pay', {'session_id': session_id})
    redelivered = fakes_control(
        world_live,
        '/control/stripe/webhook',
        {'session_id': session_id, 'type': 'checkout.session.async_payment_succeeded'},
    )

    finished = remi_post(world_live, CHECKOUT_FINISH_PATH, finish, token=token)
    again = remi_post(world_live, CHECKOUT_FINISH_PATH, finish, token=token)

    assert paid['webhook_status'] == 200
    assert redelivered['webhook_status'] == 200
    assert finished.json() == again.json()
    assert finished.json()['paid'] is True
    assert finished.json()['account']['balance_seconds'] == PACK_SECONDS


def test_a_checkout_while_stripe_is_down_is_unavailable_and_recovers(world_live: World) -> None:
    token = remi_signup(world_live, email=address_unique('outage'))

    fakes_control(world_live, '/control/faults', {'stripe_down': True})

    try:
        refused = remi_post(world_live, CHECKOUT_PATH, {'hours': PACK_HOURS}, token=token)
    finally:
        fakes_control(world_live, '/control/faults', {'stripe_down': False})

    recovered = remi_post(world_live, CHECKOUT_PATH, {'hours': PACK_HOURS}, token=token)

    assert refused.status == 503
    assert refused.json()['error']['code'] == 'payments_unavailable'
    assert recovered.status == 200


def test_the_return_page_answers_a_stripe_redirect(world_live: World) -> None:
    returned = remi_get(world_live, '/checkout/return/')

    assert returned.status == 200
    assert b'Payment received' in returned.body
