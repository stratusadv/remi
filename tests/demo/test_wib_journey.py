from __future__ import annotations

import mimetypes
import re

import pytest

from pathlib import Path
from typing_extensions import TYPE_CHECKING
from urllib.parse import urlsplit

from limelight import Demo, StaticApplication
from playwright.sync_api import expect

if TYPE_CHECKING:
    from playwright.sync_api import FrameLocator, Locator, Page, Route


ACCOUNT_EMAIL = 'avery@example.com'
ACCOUNT_NAME = 'Avery Quinn'
ACCOUNT_NAME_FIRST = 'Avery'
ACCOUNT_NAME_LAST = 'Quinn'
ACCOUNT_REGION = 'Alberta'

AGENT_WINDOWS = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
)

BALANCE_PURCHASED = '70 hours left'
BALANCE_SIGNED_UP = '50 hours left'
CHECKOUT_HOURS = '20'
CHECKOUT_PAY = 'Pay $20.00'
CODE_PERSONAL = 'WIB-7KQ4-M9TX'
DOCS = Path(__file__).resolve().parents[2] / 'docs'
EDITOR = '.rich-editor-content .ProseMirror'

EMAIL_STATUS_SENT = (
    'The email is on its way. '
    'Check your spam folder if it is not in your inbox in a minute.'
)

FUNNEL_ORIGIN_DECLARATION = re.compile(r"^const funnel_origin = '[^']*';$", re.MULTILINE)
JOURNEY = Path(__file__).resolve().parent / 'journey'
NOTES_TEMPLATE = 'Meeting notes'
NOTES_TIMEOUT_MS = 30_000
ORIGIN_API = 'https://api.remirememberthat.com'
ORIGIN_SITE = 'https://remirememberthat.com'
QUESTION = 'Who is drafting the offline banner copy?'
RECORDING_FILE = 'weekly-sync.m4a'
RECORDING_TITLE = 'Weekly platform sync'
RELEASE_DOWNLOAD = 'https://github.com/stratusadv/remi/releases/download/v0.2.0/'
RELEASE_LATEST = 'https://api.github.com/repos/stratusadv/remi/releases/latest'
RELEASE_PUBLISHED = '2026-11-18T08:34:20Z'
RELEASE_TAG = 'v0.2.0'
SETUP_PAGE_COUNT = 3
STREAM_TIMEOUT_MS = 30_000
TRANSCRIPT_ROW_COUNT = 8
WELCOME_BALANCE = 'You have 50 hours of transcription to start.'

PAGE_SETUP = f"""
Object.defineProperty(Navigator.prototype, 'userAgent', {{ get: () => '{AGENT_WINDOWS}' }})

if (location.origin === '{ORIGIN_SITE}') localStorage.setItem('remi.consent', 'denied')
"""

RELEASE_ASSETS = (
    ('remi-0.2.0-1.x86_64.rpm', 7_266_261),
    ('remi_0.2.0_amd64.AppImage', 103_508_472),
    ('remi_0.2.0_amd64.deb', 7_262_654),
    ('remi_0.2.0_universal.dmg', 13_137_375),
    ('remi_0.2.0_x64-setup.exe', 5_357_518),
)


def _api_serve(route: Route) -> None:
    assert route.request.url.startswith(f'{ORIGIN_API}/api/v1/funnel/')
    assert route.request.method == 'POST'

    headers = {'access-control-allow-origin': ORIGIN_SITE}

    route.fulfill(status=204, headers=headers)


def _dialog(page: Page, title: str) -> Locator:
    assert not page.is_closed()
    assert len(title) > 0

    heading = page.get_by_role('heading', name=title)

    return page.get_by_role('dialog').filter(has=heading)


def _download_serve(route: Route) -> None:
    assert route.request.url.startswith(RELEASE_DOWNLOAD)
    assert route.request.method == 'GET'

    name = urlsplit(route.request.url).path.rsplit('/', 1)[-1]
    headers = {'content-disposition': f'attachment; filename="{name}"'}

    route.fulfill(body=b'MZ', content_type='application/octet-stream', headers=headers)


def _funnel_origin_set(source: bytes) -> bytes:
    assert len(source) > 0
    assert ORIGIN_API.startswith('https://')

    script = source.decode()
    declaration = f"const funnel_origin = '{ORIGIN_API}';"

    assert FUNNEL_ORIGIN_DECLARATION.search(script) is not None

    return FUNNEL_ORIGIN_DECLARATION.sub(declaration, script, count=1).encode()


def _release_serve(route: Route) -> None:
    assert route.request.url == RELEASE_LATEST
    assert route.request.method == 'GET'

    assets = [
        {'browser_download_url': f'{RELEASE_DOWNLOAD}{name}', 'name': name, 'size': size}
        for name, size in RELEASE_ASSETS
    ]

    release = {'assets': assets, 'published_at': RELEASE_PUBLISHED, 'tag_name': RELEASE_TAG}
    headers = {'access-control-allow-origin': ORIGIN_SITE}

    route.fulfill(json=release, headers=headers)


def _scene_ask(demo: Demo) -> None:
    assert not demo.page.is_closed()
    assert len(demo.page.url) > 0

    page = demo.page
    question = page.locator('main').get_by_role('textbox', name='Question')
    exchange = page.locator('main .ask-exchange').last

    demo.click(_sidebar_button(page, 'Ask'))
    demo.fill(question, QUESTION)
    demo.press(question, 'Enter')

    expect(exchange.get_by_role('button', name='Copy', exact=True)).to_be_visible(
        timeout=STREAM_TIMEOUT_MS,
    )

    demo.reveal(
        exchange,
        headline='Ask the notes',
        body='A question is answered from the meetings, with a link to the line that says it.',
    )

    demo.narrate(
        'That is the whole path',
        body='Scan, get the code by email, install, sign up, buy hours, record, and ask.',
    )


def _scene_download(demo: Demo) -> None:
    assert not demo.page.is_closed()
    assert demo.page.url.startswith(f'{ORIGIN_SITE}/wib/download/')

    page = demo.page

    expect(page.locator('#code')).to_have_text(CODE_PERSONAL)

    demo.reveal(
        page.locator('.stub'),
        headline='The download page',
        body='The personal code shows here too, ready for when remi first opens.',
    )

    demo.spotlight(
        page.locator('[data-first-launch="windows"]'),
        label='What Windows will ask on the first launch',
    )

    with page.expect_download():
        demo.click(page.get_by_role('link', name='Download for Windows'))


def _scene_email(demo: Demo) -> None:
    assert not demo.page.is_closed()
    assert demo.page.url.startswith(ORIGIN_SITE)

    page = demo.page
    email = page.frame_locator('#email')

    page.goto(f'{ORIGIN_SITE}/journey/inbox.html')

    demo.narrate(
        'The email',
        body='The email arrives within a minute. It is opened on the computer that will run remi.',
    )

    demo.click(page.locator('#message'))

    demo.reveal(
        email.locator('.code'),
        headline='A personal code',
        body='The code belongs to this attendee and is worth 50 hours of transcription.',
    )

    demo.follow(
        email.get_by_role('link', name='Click here to get started'),
        label='The link to the download page',
    )


def _scene_hours(demo: Demo) -> None:
    assert not demo.page.is_closed()
    assert len(demo.page.url) > 0

    page = demo.page
    card = page.locator('.hours-card')

    demo.click(_sidebar_button(page, 'Buy hours'))
    demo.fill(card.get_by_label('How many hours?'), CHECKOUT_HOURS)

    demo.reveal(
        card,
        headline='Buy more hours',
        body='An hour of transcription costs a dollar. The card shows the balance after paying.',
    )

    demo.click(card.get_by_role('button', name='Buy hours'))

    demo.reveal(
        page.locator('.checkout-panel'),
        headline='Pay by card',
        body='The card form comes from Stripe. This recording uses a test stand-in for it.',
    )

    demo.click(page.get_by_role('button', name=CHECKOUT_PAY))

    thanks = _dialog(page, 'Thank you')

    demo.reveal(
        thanks.get_by_role('document'),
        headline='Paid',
        body='The hours are added as soon as the payment goes through.',
    )

    demo.click(thanks.get_by_role('button', name='OK'))

    balance = page.locator('.sidebar-balance-text')

    expect(balance).to_have_text(BALANCE_PURCHASED)

    demo.spotlight(balance, label='The 20 hours are on the account')


def _scene_install(demo: Demo) -> None:
    assert not demo.page.is_closed()
    assert demo.page.url.startswith(f'{ORIGIN_SITE}/wib/download/')

    page = demo.page
    more = page.get_by_role('button', name='More info')

    page.goto(f'{ORIGIN_SITE}/journey/install.html')

    demo.narrate(
        'Install remi',
        body='These are the real screens of a fresh Windows 11 computer installing remi 0.2.0.',
    )

    demo.click(page.get_by_role('button', name='remi_0.2.0_x64-setup'))

    demo.reveal(
        more,
        headline='Windows SmartScreen',
        body='remi is new to SmartScreen, so Windows asks first. More info, then Run anyway.',
    )

    demo.click(more)
    demo.click(page.get_by_role('button', name='Run anyway'))

    demo.narrate(
        'Setup',
        body='Setup installs remi for this Windows user, with no administrator prompt.',
    )

    for _ in range(SETUP_PAGE_COUNT):
        demo.click(page.get_by_role('button', name='Next'))

    demo.click(page.get_by_role('button', name='Finish'))
    demo.narrate('remi opens', body='Finish starts remi on its welcome screen.')


def _scene_offer(demo: Demo, phone: FrameLocator) -> None:
    assert not demo.page.is_closed()
    assert demo.page.url.endswith('/journey/phone.html')

    demo.reveal(
        phone.locator('.painting-copy'),
        headline='The Women in Business page',
        body='The page explains remi and offers $50 of free processing, which is 50 hours.',
    )

    demo.click(phone.get_by_role('link', name='Get your $50 code'))
    demo.fill(phone.get_by_label('First name'), ACCOUNT_NAME_FIRST)
    demo.fill(phone.get_by_label('Last name'), ACCOUNT_NAME_LAST)
    demo.fill(phone.get_by_label('Your email'), ACCOUNT_EMAIL)
    demo.click(phone.get_by_role('button', name='Email my code'))

    status = phone.locator('#email-status')

    expect(status).to_have_text(EMAIL_STATUS_SENT)

    demo.reveal(
        status,
        headline='The code is on its way',
        body='remi emails a personal code and the download link to that address.',
    )


def _scene_scan(demo: Demo) -> FrameLocator:
    assert not demo.page.is_closed()
    assert demo.page.url == 'about:blank'

    page = demo.page

    page.goto(f'{ORIGIN_SITE}/journey/phone.html')

    _ = demo.title(
        'From a table card to meeting notes',
        kicker='remi at Women in Business',
        subtitle='The path an attendee takes, from the QR code to asking the notes.',
    )

    demo.reveal(
        page.locator('.card'),
        headline='The conference card',
        body='The QR code on this card opens the remi offer page for Women in Business.',
    )

    demo.spotlight(page.locator('.viewfinder'), label='The phone camera reads the code')
    demo.click(page.get_by_role('button', name='Open remirememberthat.com'))

    return page.frame_locator('#browser')


def _scene_sign_up(demo: Demo) -> None:
    assert not demo.page.is_closed()
    assert demo.page.url.endswith('/journey/install.html')

    page = demo.page
    query = {'billing': 'signed-out', 'library': 'empty', 'settings': 'initial'}

    demo.goto('/', query=query)

    expect(page.locator('.app-shell[data-ready="true"]')).to_be_visible()

    demo.narrate(
        'Sign up',
        body='A new account needs a name, an email, the province, and the code from the email.',
    )

    demo.fill(page.get_by_label('Name', exact=True), ACCOUNT_NAME)
    demo.fill(page.get_by_label('Email', exact=True), ACCOUNT_EMAIL)
    demo.select(page.get_by_label('Province or territory'), ACCOUNT_REGION)
    demo.fill(page.get_by_label('Promo code (optional)'), CODE_PERSONAL)
    demo.click(page.get_by_role('button', name='Get started'))

    welcome = _dialog(page, 'Welcome to remi')

    expect(welcome).to_contain_text(WELCOME_BALANCE)

    demo.reveal(
        welcome.get_by_role('document'),
        headline='The code is applied',
        body='The personal code puts 50 hours on the new account.',
    )

    demo.click(welcome.get_by_role('button', name='OK'))

    balance = page.locator('.sidebar-balance-text')

    expect(balance).to_have_text(BALANCE_SIGNED_UP)

    demo.spotlight(balance, label='The balance in hours')


def _scene_transcribe(demo: Demo) -> None:
    assert not demo.page.is_closed()
    assert len(demo.page.url) > 0

    page = demo.page

    demo.click(_sidebar_button(page, 'Home'))

    demo.narrate(
        'A first recording',
        body='Home starts empty. A recording comes from a file or from the microphone.',
    )

    demo.click(page.get_by_role('button', name='New recording').first)
    demo.click(page.get_by_role('button', name='Open or drop a recording'))

    expect(page.locator('.file-picker-name')).to_have_text(RECORDING_FILE)

    demo.click(page.get_by_role('button', name='Transcribe', exact=True))

    rows = page.locator('.transcript-pane-row')

    expect(rows).to_have_count(TRANSCRIPT_ROW_COUNT, timeout=STREAM_TIMEOUT_MS)

    demo.reveal(
        page.locator('.transcript-pane'),
        headline='The transcript',
        body='remi sends the audio to its servers and streams the transcript back.',
    )

    demo.click(page.get_by_role('button', name='Next'))

    demo.spotlight(
        page.locator('.step-bar-item[aria-current="step"]'),
        label='The meeting details go with the notes',
    )

    template = page.get_by_label('Template', exact=True)

    demo.spotlight(template, label='The template sets the sections of the notes')
    demo.select(template, NOTES_TEMPLATE)
    demo.click(page.get_by_role('button', name='Next'))

    heading = page.locator(EDITOR).locator('h1')

    expect(heading).to_have_text(RECORDING_TITLE, timeout=NOTES_TIMEOUT_MS)

    demo.reveal(
        page.locator(EDITOR),
        headline='The notes',
        body='A summary, the decisions, and the action items, each tied to its moment.',
    )


def _sidebar_button(page: Page, label: str) -> Locator:
    assert not page.is_closed()
    assert len(label) > 0

    return page.locator('aside').get_by_role('button', name=label, exact=True)


def _site_file(path: str) -> Path | None:
    assert path.startswith('/')
    assert '..' not in path

    page = f'{path}index.html' if path.endswith('/') else path
    journey = page.startswith('/journey/')
    base = JOURNEY if journey else DOCS
    file = base / page.removeprefix('/journey/' if journey else '/')

    return file if file.is_file() else None


def _site_serve(route: Route) -> None:
    assert route.request.url.startswith(f'{ORIGIN_SITE}/')
    assert route.request.method == 'GET'

    file = _site_file(urlsplit(route.request.url).path)

    if file is None:
        route.fulfill(status=404)

        return

    content_type = mimetypes.guess_type(file.name)[0] or 'application/octet-stream'
    body = file.read_bytes()

    if file.name == 'funnel.js':
        body = _funnel_origin_set(body)

    route.fulfill(body=body, content_type=content_type)


@pytest.mark.usefixtures('standins')
def test_wib_journey(base_url: str, page: Page) -> None:
    assert base_url.startswith('http://')
    assert not page.is_closed()

    page.add_init_script(script=PAGE_SETUP)
    page.route(f'{ORIGIN_SITE}/**', _site_serve)
    page.route(f'{ORIGIN_API}/**', _api_serve)
    page.route(RELEASE_LATEST, _release_serve)
    page.route(f'{RELEASE_DOWNLOAD}**', _download_serve)

    application = StaticApplication(base_url=base_url)
    demo = Demo(page, application, name='wib-journey')
    phone = _scene_scan(demo)

    _scene_offer(demo, phone)
    _scene_email(demo)
    _scene_download(demo)
    _scene_install(demo)
    _scene_sign_up(demo)
    _scene_hours(demo)
    _scene_transcribe(demo)
    _scene_ask(demo)
