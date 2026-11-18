const campaigns = Object.freeze(['general', 'wib']);
const code_pattern = /^[A-Za-z0-9-]{1,64}$/u;
const email_timeout_milliseconds = 15_000;
const funnel_origin = '';
const pages = Object.freeze(['landing', 'promo']);
const platforms = Object.freeze(['linux', 'macos', 'windows']);

const email_statuses = Object.freeze({
    failed: 'The email did not send. Your mail app can send it instead.',
    invalid: 'That address does not look right. Check it and try again.',
    sending: 'The email is sending.',
    sent: 'The email is on its way. Check your spam folder if it is not in your inbox in a minute.',
});

const installers = Object.freeze([
    Object.freeze({ platform: 'linux', suffix: '.AppImage' }),
    Object.freeze({ platform: 'linux', suffix: '.deb' }),
    Object.freeze({ platform: 'linux', suffix: '.rpm' }),
    Object.freeze({ platform: 'macos', suffix: '.dmg' }),
    Object.freeze({ platform: 'windows', suffix: '-setup.exe' }),
]);

const campaign = document.body.dataset.campaign;
const installers_known = installers.every((installer) => platforms.includes(installer.platform));
const page = document.body.dataset.page ?? null;

assert(campaigns.includes(campaign), `the page names no known campaign: ${campaign}`);
assert(installers_known, 'each installer names a platform the server counts');
assert(page === null || pages.includes(page), `the page names no known funnel page: ${page}`);

if (funnel_origin !== '') {
    if (page === 'promo') beacon_send('click', { campaign, page });

    document.addEventListener('click', click_watch);
    email_offer();
}

function assert(condition, message) {
    console.assert(typeof condition === 'boolean', 'assert expects a boolean condition');
    console.assert(typeof message === 'string', 'assert expects a message');

    if (condition) return;

    throw new Error(message);
}

function beacon_send(kind, fields) {
    assert(kind === 'click' || kind === 'download', `${kind} is not a funnel beacon`);
    assert(campaigns.includes(fields.campaign), `${fields.campaign} is not a campaign`);
    assert(funnel_origin.startsWith('https://'), 'the funnel origin is not https');

    const address = `${funnel_origin}/api/v1/funnel/${kind}/`;
    const queued = navigator.sendBeacon(address, new URLSearchParams(fields));

    if (!queued) console.warn(`the ${kind} beacon was not queued`);
}

function click_watch(event) {
    assert(event.type === 'click', 'the click watcher saw an event other than a click');
    assert(event.currentTarget === document, 'the click watcher listens on the document');

    if (!(event.target instanceof Element)) return;

    const cta = event.target.closest('[data-cta]');

    if (cta !== null) {
        if (page === 'landing') beacon_send('click', { campaign, page });
    }

    const link = event.target.closest('a[href]');

    if (link === null) return;

    const platform = platform_of(link.href);

    if (platform === null) return;

    const code = code_given();
    const fields = code === '' ? { campaign, platform } : { campaign, code, platform };

    beacon_send('download', fields);
}

function code_given() {
    const given = (new URLSearchParams(location.search).get('code') ?? '').trim();

    assert(typeof given === 'string', 'a code from the address is text');

    return code_pattern.test(given) ? given.toUpperCase() : '';
}

function email_offer() {
    const form = document.getElementById('email');
    const mailto = document.getElementById('mailto');

    if (form === null) return;

    assert(form instanceof HTMLFormElement, 'the email offer is a form');
    assert(mailto !== null, 'the email form keeps the mail app link as its fallback');

    form.hidden = false;
    mailto.hidden = true;
    form.addEventListener('submit', email_submit);
}

function email_outcome(status) {
    assert(Number.isInteger(status), 'a response status is an integer');
    assert(status >= 200, `${status} is not a final HTTP status`);
    assert(status <= 599, `${status} is not an HTTP status`);

    if (status === 204) return 'sent';
    if (status === 400) return 'invalid';

    return 'failed';
}

function email_send(fields) {
    assert(typeof fields.email === 'string', 'an email address is text');
    assert(typeof fields.name_first === 'string', 'a first name is text');
    assert(typeof fields.name_last === 'string', 'a last name is text');
    assert(funnel_origin.startsWith('https://'), 'the funnel origin is not https');

    const body = new URLSearchParams({
        campaign,
        email: fields.email,
        name_first: fields.name_first,
        name_last: fields.name_last,
    });

    const endpoint = `${funnel_origin}/api/v1/funnel/email/`;
    const signal = AbortSignal.timeout?.(email_timeout_milliseconds);

    return fetch(endpoint, { body, method: 'POST', signal })
        .then((response) => email_outcome(response.status))
        .catch((error) => {
            console.warn('the email request failed', error);

            return 'failed';
        });
}

function email_submit(event) {
    assert(event.type === 'submit', 'the email handler saw an event other than a submit');
    assert(event.currentTarget instanceof HTMLFormElement, 'the email handler listens on the form');

    event.preventDefault();

    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const address = form.elements.namedItem('email');
    const name_first = form.elements.namedItem('name_first');
    const name_last = form.elements.namedItem('name_last');
    const status = document.getElementById('email-status');

    assert(address instanceof HTMLInputElement, 'the email form has an address field');
    assert(name_first instanceof HTMLInputElement, 'the email form has a first name field');
    assert(name_last instanceof HTMLInputElement, 'the email form has a last name field');

    const fields = {
        email: address.value,
        name_first: name_first.value.trim(),
        name_last: name_last.value.trim(),
    };

    button.disabled = true;
    status.textContent = email_statuses.sending;

    return email_send(fields).then((outcome) => {
        const mailto = document.getElementById('mailto');

        button.disabled = false;
        status.textContent = email_statuses[outcome];

        if (outcome === 'sent') form.reset();
        if (outcome === 'failed') mailto.hidden = false;
    });
}

function platform_of(address) {
    assert(typeof address === 'string', 'a download address is text');
    assert(address.length > 0, 'a download address is never empty');

    const path = new URL(address).pathname;
    const installer = installers.find((candidate) => path.endsWith(candidate.suffix));

    return installer === undefined ? null : installer.platform;
}
