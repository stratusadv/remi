from __future__ import annotations

import re

import pytest

from typing_extensions import TYPE_CHECKING
from urllib.parse import urlencode

from harness.world.client import address_unique, fakes_control, fakes_state, remi_beacon

if TYPE_CHECKING:
    from harness.world.world import World


CODE_PATTERN = re.compile(r'WIB-[23456789A-HJKMNP-TV-Z]{4}-[23456789A-HJKMNP-TV-Z]{4}')
EMAIL_PATH = '/api/v1/funnel/email/'

pytestmark = pytest.mark.system


def _messages_to(world: World, address: str) -> list[dict[str, object]]:
    assert '@' in address

    return [
        message
        for message in fakes_state(world)['sendgrid_messages']
        if message['to'] == [address]
    ]


def test_the_conference_email_reaches_sendgrid_with_a_personal_code_and_its_link(
    world_live: World,
) -> None:
    address = address_unique('email')
    fields = {'campaign': 'wib', 'email': f'  {address.upper()} '}
    sent = remi_beacon(world_live, EMAIL_PATH, fields)
    messages = _messages_to(world_live, address.upper())
    text = str(messages[0]['text'])
    code = CODE_PATTERN.search(text)

    assert sent.status == 204
    assert len(messages) == 1
    assert messages[0]['subject'] == 'Your remi code for Women in Business'
    assert code is not None

    query = urlencode({'code': code.group(), 'utm_source': 'email'})
    link = f'https://remirememberthat.com/wib/download/?{query}'

    assert link in text
    assert code.group() in str(messages[0]['html'])
    assert 'It covers 50 hours of free meeting notes.' in text


def test_an_email_sendgrid_refuses_is_unavailable_and_the_address_can_retry(
    world_live: World,
) -> None:
    address = address_unique('retry')
    fields = {'campaign': 'general', 'email': address}

    fakes_control(world_live, '/control/faults', {'sendgrid_down': True})

    try:
        refused = remi_beacon(world_live, EMAIL_PATH, fields)
    finally:
        fakes_control(world_live, '/control/faults', {'sendgrid_down': False})

    retried = remi_beacon(world_live, EMAIL_PATH, fields)
    messages = _messages_to(world_live, address)

    assert refused.status == 503
    assert refused.json()['error']['code'] == 'email_unavailable'
    assert retried.status == 204
    assert len(messages) == 1
    assert messages[0]['subject'] == 'Download remi'
