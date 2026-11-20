const banner_sheet = new CSSStyleSheet();
const choice_key = 'remi.consent';
const choices = Object.freeze(['denied', 'granted']);
const cookie_pattern = /^_ga(?:_|$)/u;
const data_layer_key = 'dataLayer';
const measurement_disable_key = 'ga-disable-G-GYQQ1H2S7Z';
const module_address = import.meta.url;
const privacy_address = new URL('../privacy/', module_address).href;
const settings_selector = 'a[href$="#cookie-settings"]';
const tag_manager_address = 'https://www.googletagmanager.com/gtm.js?id=GTM-W33NVHZH';
const tag_manager_event = 'gtm.js';
const tag_manager_selector = `script[src="${tag_manager_address}"]`;

const banner_markup = `
    <p>
        This website uses Google Analytics cookies to learn how visitors find and use it.
        The Decline button turns them off. <a href="${privacy_address}">Privacy policy</a>
    </p>
    <div class="consent-actions">
        <button type="button" value="denied">Decline</button>
        <button type="button" value="granted">Accept</button>
    </div>
`;

const banner_styles = `
    .consent {
        position: fixed;
        bottom: 16px;
        left: 16px;
        z-index: 1000;
        display: grid;
        gap: 14px;
        box-sizing: border-box;
        width: min(416px, calc(100vw - 32px));
        margin: 0;
        padding: 18px 20px;
        background: #0b1018;
        color: #eef2f7;
        font: 400 14px/1.5 "Geist", system-ui, sans-serif;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16), 5px 5px 0 #00a2d2;
    }

    .consent p {
        margin: 0;
    }

    .consent a {
        color: inherit;
        text-decoration: underline;
        text-underline-offset: 0.2em;
        white-space: nowrap;
    }

    .consent a:hover {
        color: #4fd0f5;
    }

    .consent-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
    }

    .consent button {
        height: 40px;
        margin: 0;
        padding: 0 16px;
        border: 0;
        border-radius: 0;
        background: #f6f8fb;
        color: #07090d;
        font: 600 14px/1 "Geist", system-ui, sans-serif;
        cursor: pointer;
    }

    .consent button:hover {
        background: #d3dce7;
    }

    .consent button:focus-visible {
        outline: 2px solid #4fd0f5;
        outline-offset: 2px;
    }
`;

const choice_stored = choice_read();

banner_sheet.replaceSync(banner_styles);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, banner_sheet];
addEventListener('click', settings_open, { capture: true });

if (choice_stored !== 'denied') tag_manager_load();
if (choice_stored === 'denied') cookies_clear();
if (choice_stored === null) banner_show();

function assert(condition, message) {
    console.assert(typeof condition === 'boolean', 'assert expects a boolean condition');
    console.assert(typeof message === 'string', 'assert expects a message');

    if (condition) return;

    throw new Error(message);
}

function banner_choose(event) {
    assert(event.type === 'click', 'the banner saw an event other than a click');
    assert(event.currentTarget instanceof HTMLButtonElement, 'the banner listens on its buttons');

    const choice = event.currentTarget.value;
    const banner = event.currentTarget.closest('.consent');

    assert(choices.includes(choice), `${choice} is not a cookie choice`);
    assert(banner instanceof HTMLElement, 'a cookie choice comes from the banner');

    choice_write(choice);
    banner.remove();

    assert(!banner.isConnected, 'the banner leaves the page once a choice is made');

    if (choice === 'granted') {
        tag_manager_load();

        return;
    }

    window[measurement_disable_key] = true;
    cookies_clear();

    if (tag_manager_started()) location.reload();
}

function banner_show() {
    const shown = document.querySelector('.consent');

    if (shown instanceof HTMLElement) return shown;

    const banner = document.createElement('section');

    banner.className = 'consent';
    banner.setAttribute('aria-label', 'Cookie choice');
    banner.innerHTML = banner_markup;

    const buttons = banner.querySelectorAll('button');

    assert(buttons.length === choices.length, 'the banner offers each cookie choice');

    for (const button of buttons) {
        button.addEventListener('click', banner_choose);
    }

    document.body.prepend(banner);

    assert(banner.isConnected, 'the banner is on the page');
    assert(document.body.firstElementChild === banner, 'the banner leads the page');

    return banner;
}

function choice_read() {
    try {
        const stored = localStorage.getItem(choice_key);

        return choices.includes(stored) ? stored : null;
    } catch (error) {
        console.warn('the cookie choice could not be read', error);

        return null;
    }
}

function choice_write(choice) {
    assert(choices.includes(choice), `${choice} is not a cookie choice`);

    try {
        localStorage.setItem(choice_key, choice);
    } catch (error) {
        console.warn('the cookie choice could not be saved', error);
    }
}

function cookies_analytics() {
    return document.cookie
        .split(';')
        .map((pair) => pair.split('=', 1)[0].trim())
        .filter((name) => cookie_pattern.test(name));
}

function cookies_clear() {
    const names = cookies_analytics();

    assert(location.hostname.length > 0, 'the page has a host to clear cookies on');

    for (const name of names) {
        document.cookie = `${name}=; Max-Age=0; Path=/`;
        document.cookie = `${name}=; Max-Age=0; Path=/; Domain=${location.hostname}`;
    }

    assert(cookies_analytics().length === 0, 'the analytics cookies are gone');
}

function settings_open(event) {
    assert(event.type === 'click', 'the settings watcher saw an event other than a click');
    assert(event.currentTarget === window, 'the settings watcher listens on the window');

    if (!(event.target instanceof Element)) return;

    const link = event.target.closest(settings_selector);

    if (link === null) return;

    event.preventDefault();
    event.stopPropagation();
    banner_show().querySelector('button').focus();
}

function tag_manager_load() {
    if (tag_manager_started()) return;

    const script = document.createElement('script');

    window[data_layer_key] ??= [];

    assert(Array.isArray(window[data_layer_key]), 'the data layer is a list');

    window[data_layer_key].push({ 'gtm.start': Date.now(), event: tag_manager_event });
    script.async = true;
    script.src = tag_manager_address;
    document.head.append(script);

    assert(script.isConnected, 'the tag manager script is on the page');
    assert(document.querySelector(tag_manager_selector) === script, 'the tag manager loads once');
    assert(tag_manager_started(), 'the data layer records the tag manager start');
}

function tag_manager_started() {
    const data_layer = window[data_layer_key];

    assert(data_layer === undefined || Array.isArray(data_layer), 'the data layer is a list');

    if (data_layer === undefined) return false;

    return data_layer.some((message) => message?.event === tag_manager_event);
}
