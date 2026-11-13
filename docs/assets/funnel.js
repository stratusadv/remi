const campaigns = Object.freeze(['general', 'wib']);
const funnel_origin = '';
const platforms = Object.freeze(['linux', 'macos', 'windows']);
const sources = Object.freeze(['link', 'qr']);

const installers = Object.freeze([
    Object.freeze({ platform: 'linux', suffix: '.AppImage' }),
    Object.freeze({ platform: 'linux', suffix: '.deb' }),
    Object.freeze({ platform: 'linux', suffix: '.rpm' }),
    Object.freeze({ platform: 'macos', suffix: '.dmg' }),
    Object.freeze({ platform: 'windows', suffix: '-setup.exe' }),
]);

const campaign = document.body.dataset.campaign;
const installers_known = installers.every((installer) => platforms.includes(installer.platform));

assert(campaigns.includes(campaign), `the page names no known campaign: ${campaign}`);
assert(installers_known, 'each installer names a platform the server counts');

if (funnel_origin !== '') {
    beacon_send('visit', { campaign, source: source_detect() });
    document.addEventListener('click', download_watch);
}

function assert(condition, message) {
    console.assert(typeof condition === 'boolean', 'assert expects a boolean condition');
    console.assert(typeof message === 'string', 'assert expects a message');

    if (condition) return;

    throw new Error(message);
}

function beacon_send(kind, fields) {
    assert(kind === 'visit' || kind === 'download', `${kind} is not a funnel beacon`);
    assert(campaigns.includes(fields.campaign), `${fields.campaign} is not a campaign`);
    assert(funnel_origin.startsWith('https://'), 'the funnel origin is not https');

    const address = `${funnel_origin}/api/v1/funnel/${kind}/`;
    const queued = navigator.sendBeacon(address, new URLSearchParams(fields));

    if (!queued) console.warn(`the ${kind} beacon was not queued`);
}

function download_watch(event) {
    assert(event.type === 'click', 'the download watcher saw an event other than a click');
    assert(event.currentTarget === document, 'the download watcher listens on the document');

    if (!(event.target instanceof Element)) return;

    const link = event.target.closest('a[href]');

    if (link === null) return;

    const platform = platform_of(link.href);

    if (platform === null) return;

    beacon_send('download', { campaign, platform });
}

function platform_of(address) {
    assert(typeof address === 'string', 'a download address is text');
    assert(address.length > 0, 'a download address is never empty');

    const path = new URL(address).pathname;
    const installer = installers.find((candidate) => path.endsWith(candidate.suffix));

    return installer === undefined ? null : installer.platform;
}

function source_detect() {
    const source = new URLSearchParams(location.search).get('utm_source') === 'qr' ? 'qr' : 'link';

    assert(sources.includes(source), `${source} is not a funnel source`);

    return source;
}
