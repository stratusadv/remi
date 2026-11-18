from __future__ import annotations

import re

from typing_extensions import TYPE_CHECKING

from limelight import Demo, StaticApplication
from playwright.sync_api import expect

if TYPE_CHECKING:
    from playwright.sync_api import Locator, Page, Route, WebSocketRoute


ACCOUNT_EMAIL = 'avery@example.com'
ACCOUNT_NAME = 'Avery Quinn'
ACCOUNT_PROMO_CODE = 'WIB2026'
ACCOUNT_REGION = 'Alberta'
CHECKOUT_HOURS = '20'
CHECKOUT_PAY = 'Pay $20.00'
EDITOR = '.rich-editor-content .ProseMirror'
HMR_SOCKET = re.compile(r'^ws://[^/]+/\?token=')
NOTES_TIMEOUT_MS = 30_000
RECORDING_MEETING = 'discovery-call.wav'
RECORDING_TITLE = 'Weekly platform sync'
STRIPE_ROUTE = 'https://js.stripe.com/**'
STRIPE_STANDIN_TYPE = 'application/javascript'

MICROPHONE_FAKE = """
navigator.mediaDevices.getUserMedia = async () => {
    const context = new AudioContext()
    const destination = context.createMediaStreamDestination()
    const voice = new OscillatorNode(context, { type: 'sawtooth', frequency: 140 })
    const syllable = new GainNode(context, { gain: 0.6 })
    const phrase = new GainNode(context, { gain: 0.09 })

    for (const [level, depth, frequency] of [[syllable, 0.4, 3.5], [phrase, 0.04, 0.5]]) {
        const swing = new OscillatorNode(context, { frequency })

        swing.connect(new GainNode(context, { gain: depth })).connect(level.gain)
        swing.start()
    }

    voice.connect(syllable).connect(phrase).connect(destination)
    voice.start()

    await context.resume()

    return destination.stream
}
"""

STRIPE_STANDIN = """
window.Stripe = function () {
    return {
        createPaymentMethod: function () {
            return Promise.resolve({ paymentMethod: { id: 'pm_standin' } })
        },
        initCheckoutElementsSdk: function () {
            var handlers = {}
            var total = { amount: '$20.00', minorUnitsAmount: 2000 }
            var session = {
                currency: 'cad',
                email: 'avery@example.com',
                minorUnitsAmountDivisor: 100,
                total: { total: total },
            }

            var actions = {
                confirm: function () { return Promise.resolve({ type: 'success', session }) },
                getSession: function () { return session },
            }

            var element = {
                destroy: function () {},
                mount: function (host) {
                    host.innerHTML = '<input aria-label="Card number" value="4242 4242 4242 4242">'
                    setTimeout(function () { handlers.ready({ elementType: 'payment' }) }, 0)
                },
                on: function (event, handler) { handlers[event] = handler; return element },
            }

            return {
                changeAppearance: function () {},
                createPaymentElement: function () { return element },
                loadActions: function () { return Promise.resolve({ type: 'success', actions }) },
            }
        },
    }
}

window.Stripe.version = 'endive'
"""


def _dialog(page: Page, title: str) -> Locator:
    assert not page.is_closed()
    assert len(title) > 0

    heading = page.get_by_role('heading', name=title)

    return page.get_by_role('dialog').filter(has=heading)


def _hmr_socket_stub(websocket: WebSocketRoute) -> None:
    assert HMR_SOCKET.match(websocket.url) is not None
    assert not websocket.url.endswith('=')


def _scene_checkout(demo: Demo) -> None:
    assert not demo.page.is_closed()
    assert len(demo.page.url) > 0

    page = demo.page

    demo.click(_sidebar_button(page, 'Buy hours'))

    demo.reveal(
        page.locator('.checkout-points'),
        headline='Buy hours',
        body='The page opens with the price and what each account includes.',
    )

    card = page.locator('.hours-card')

    demo.fill(card.get_by_label('How many hours?'), CHECKOUT_HOURS)

    demo.reveal(
        card,
        headline='Choose the hours',
        body='The card shows the balance after the purchase and its total.',
    )

    demo.click(card.get_by_role('button', name='Buy hours'))

    demo.reveal(
        page.locator('.checkout-panel'),
        headline='Pay',
        body='The card form comes from Stripe. This recording uses a test stand-in for it.',
    )

    demo.click(page.get_by_role('button', name=CHECKOUT_PAY))

    thanks = _dialog(page, 'Thank you')

    demo.reveal(
        thanks.get_by_role('document'),
        headline='A thank-you after payment',
        body='The dialog confirms the payment and shows the new balance.',
    )

    demo.click(thanks.get_by_role('button', name='OK'))
    demo.spotlight(page.locator('.sidebar-balance-text'), label='The new balance')


def _scene_home(demo: Demo) -> None:
    assert not demo.page.is_closed()
    assert len(demo.page.url) > 0

    page = demo.page

    demo.reveal(
        page.locator('.folder-tag').first,
        headline='Folder tags on Home',
        body='Each recording on Home shows the folder it belongs to.',
    )

    demo.reveal(
        page.get_by_role('contentinfo').locator('.footer-credit'),
        headline='A credit in the footer',
        body='The credit sits in the middle of the footer and opens the company website.',
    )


def _scene_notes(demo: Demo) -> None:
    assert not demo.page.is_closed()
    assert len(demo.page.url) > 0

    page = demo.page
    tile = page.locator('.recording-tile:not(.recording-tile-new)')

    demo.click(tile.filter(has_text=RECORDING_MEETING))
    demo.spotlight(page.locator('.step-bar-item[aria-current="step"]'), label='The Meeting step')

    demo.narrate(
        'The notes write themselves',
        body='The Next button on the Meeting step starts the notes without a Generate click.',
    )

    demo.click(page.get_by_role('button', name='Next'))

    heading = page.locator(EDITOR).locator('h1')

    expect(heading).to_have_text(RECORDING_TITLE, timeout=NOTES_TIMEOUT_MS)

    demo.spotlight(page.locator(EDITOR), label='The notes, written without a click')


def _scene_recording(demo: Demo) -> None:
    assert not demo.page.is_closed()
    assert len(demo.page.url) > 0

    page = demo.page

    demo.click(_sidebar_button(page, 'Home'))
    demo.click(page.get_by_role('button', name='New recording').first)
    demo.click(page.get_by_role('button', name='Record with the microphone'))

    demo.reveal(
        page.locator('.recording-trace'),
        headline='A live waveform',
        body='The trace follows the microphone, so a recording shows that it hears sound.',
    )

    demo.click(page.get_by_role('button', name='Stop recording'))


def _scene_sign_up(demo: Demo) -> None:
    assert not demo.page.is_closed()
    assert demo.page.url == 'about:blank'

    page = demo.page
    query = {'billing': 'signed-out'}

    demo.goto('/', query=query)

    expect(page.locator('.app-shell[data-ready="true"]')).to_be_visible()

    _ = demo.title(
        'What is new in remi',
        subtitle='The changes from the latest round of feedback.',
    )

    demo.narrate('Sign up', body='A new account starts on the welcome screen.')
    demo.fill(page.get_by_label('Name', exact=True), ACCOUNT_NAME)
    demo.fill(page.get_by_label('Email', exact=True), ACCOUNT_EMAIL)

    province = page.get_by_label('Province or territory')

    demo.spotlight(province, label='The Canadian provinces and territories only')
    demo.select(province, ACCOUNT_REGION)
    demo.fill(page.get_by_label('Promo code (optional)'), ACCOUNT_PROMO_CODE)
    demo.click(page.get_by_role('button', name='Get started'))

    welcome = _dialog(page, 'Welcome to remi')

    demo.reveal(
        welcome.get_by_role('document'),
        headline='A welcome after sign-up',
        body='The dialog confirms the promo code and shows the starting balance.',
    )

    demo.click(welcome.get_by_role('button', name='OK'))


def _scene_templates(demo: Demo) -> None:
    assert not demo.page.is_closed()
    assert len(demo.page.url) > 0

    page = demo.page
    name = page.get_by_text('Company procedure', exact=True)
    row = page.locator('.list-divider > li').filter(has=name)

    demo.click(_sidebar_button(page, 'Templates'))

    demo.reveal(
        row,
        headline='A company procedure template',
        body='A new default template lays out a step-by-step company procedure.',
    )

    demo.click(row.locator('.list-row-main'))

    demo.reveal(
        page.locator(EDITOR),
        headline='The procedure layout',
        body='The layout holds the document details, nine sections, and a revision history.',
    )


def _sidebar_button(page: Page, label: str) -> Locator:
    assert not page.is_closed()
    assert len(label) > 0

    return page.locator('aside').get_by_role('button', name=label, exact=True)


def _stripe_standin_serve(route: Route) -> None:
    assert route.request.url.startswith('https://js.stripe.com/')
    assert route.request.method == 'GET'

    route.fulfill(body=STRIPE_STANDIN, content_type=STRIPE_STANDIN_TYPE)


def test_whats_new(base_url: str, page: Page) -> None:
    assert base_url.startswith('http://')
    assert not page.is_closed()

    page.add_init_script(script=MICROPHONE_FAKE)
    page.route(STRIPE_ROUTE, _stripe_standin_serve)
    page.route_web_socket(HMR_SOCKET, _hmr_socket_stub)

    application = StaticApplication(base_url=base_url)
    demo = Demo(page, application, name='whats-new')

    _scene_sign_up(demo)
    _scene_home(demo)
    _scene_notes(demo)
    _scene_recording(demo)
    _scene_checkout(demo)
    _scene_templates(demo)
