const platforms = Object.freeze([
    Object.freeze({ label: 'Windows 10 and 11', suffix: '-setup.exe', key: 'windows' }),
    Object.freeze({ label: 'macOS 14 and later', suffix: '_universal.dmg', key: 'macos' }),
    Object.freeze({ label: 'Ubuntu and Debian', suffix: '.deb', key: 'ubuntu' }),
    Object.freeze({ label: 'Fedora', suffix: '.rpm', key: 'fedora' }),
    Object.freeze({ label: 'Linux AppImage', suffix: '.AppImage', key: 'linux' }),
]);

const button_names = Object.freeze({
    fedora: 'Fedora',
    macos: 'macOS',
    ubuntu: 'Ubuntu',
    windows: 'Windows',
});

const font_faces = Object.freeze([
    '1em Geist',
    '1em "Geist Mono"',
    '1em Newsreader',
    'italic 1em Newsreader',
]);

const agent = navigator.userAgent;
const mac_touch = /Macintosh/.test(agent) && navigator.maxTouchPoints > 1;
const mobile = mac_touch || /Android|iPhone|iPad|iPod/.test(agent);
const megabyte_bytes = 1048576;
const youtube_id_pattern = /^[\w-]{11}$/;

copy_wire();
notice_show();
page_reveal();
video_embed();

fetch('https://api.github.com/repos/stratusadv/remi/releases/latest')
    .then((response) => response.ok ? response.json() : Promise.reject(response.status))
    .then(release_render)
    .catch((error) => {
        console.warn('the release list could not be loaded', error);
        document.getElementById('fallback').hidden = false;
    });

function assert(condition, message) {
    console.assert(typeof condition === 'boolean', 'assert expects a boolean condition');
    console.assert(typeof message === 'string', 'assert expects a message');

    if (condition) return;

    throw new Error(message);
}

function copy_wire() {
    const button = document.getElementById('copy');
    const code = document.getElementById('code');

    if (button === null) return;
    if (code === null) return;
    if (navigator.clipboard === undefined) return;

    assert(button.hidden, 'the copy button starts hidden');
    assert(code.textContent.trim().length > 0, 'the promo code is empty');

    button.hidden = false;

    button.addEventListener('click', () => {
        navigator.clipboard.writeText(code.textContent.trim()).then(
            () => { button.textContent = 'Copied'; },
            (error) => {
                console.warn('the promo code could not be copied', error);
                button.hidden = true;
            },
        );
    });
}

function element_make(tag, class_name, text) {
    assert(tag.length > 0, 'an element needs a tag');
    assert(typeof class_name === 'string', 'an element needs a class name, even empty');
    assert(typeof text === 'string', 'an element needs text, even empty');

    const element = document.createElement(tag);

    element.className = class_name;
    element.textContent = text;

    return element;
}

function notice_show() {
    const notice = document.getElementById('mobile');
    const button = document.getElementById('share');

    if (notice === null) return;
    if (!mobile) return;

    assert(notice.hidden, 'the phone notice starts hidden');

    notice.hidden = false;

    if (button === null) return;
    if (navigator.share === undefined) return;

    assert(button.hidden, 'the share button starts hidden');

    button.hidden = false;

    button.addEventListener('click', () => {
        const page = { title: document.title, url: location.origin + location.pathname };

        navigator.share(page).catch((error) => {
            if (error.name !== 'AbortError') button.hidden = true;
        });
    });
}

function page_reveal() {
    const link = document.getElementById('fonts');

    assert(link !== null, 'the page has no font stylesheet');

    const stylesheet = new Promise((resolve) => {
        if (link.sheet !== null) {
            resolve();

            return;
        }

        link.addEventListener('load', resolve);
        link.addEventListener('error', resolve);
    });

    stylesheet
        .then(() => Promise.allSettled(font_faces.map((face) => document.fonts.load(face))))
        .then(() => document.documentElement.classList.remove('loading'));
}

function platform_detect() {
    assert(typeof agent === 'string', 'the browser reports no user agent');

    if (mobile) return null;
    if (/Windows/.test(agent)) return 'windows';
    if (/Macintosh/.test(agent)) return 'macos';
    if (/Fedora/.test(agent)) return 'fedora';
    if (/Linux/.test(agent)) return 'ubuntu';

    return null;
}

function release_point(platform, asset) {
    assert(Object.hasOwn(button_names, platform.key), `${platform.key} has no button name`);
    assert(typeof asset.browser_download_url === 'string', 'the release asset has no address');

    for (const button of document.querySelectorAll('[data-get]')) {
        button.href = asset.browser_download_url;
        button.textContent = `Download for ${button_names[platform.key]}`;
    }
}

function release_render(listing) {
    assert(Array.isArray(listing.assets), 'the release carries no asset list');
    assert(typeof listing.tag_name === 'string', 'the release carries no tag');

    const others = document.getElementById('others');
    const detected = platform_detect();
    const version = listing.tag_name.replace(/^v/, '');

    assert(others !== null, 'the page has no installer list');

    for (const platform of platforms) {
        const asset = listing.assets.find((candidate) => candidate.name.endsWith(platform.suffix));

        if (asset === undefined) continue;

        others.append(release_row(platform, asset));

        if (platform.key === detected) release_point(platform, asset);
    }

    const date = new Date(listing.published_at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });

    const line = document.getElementById('release');

    line.textContent = `Version ${version}, released ${date}`;
    line.hidden = false;
}

function release_row(platform, asset) {
    assert(platforms.includes(platform), 'the platform is not one the page offers');
    assert(Number.isFinite(asset.size), 'the release asset has no size');

    const row = element_make('li', '', '');
    const link = element_make('a', '', platform.label);
    const size = element_make('small', '', ` ${(asset.size / megabyte_bytes).toFixed(0)} MB`);

    link.href = asset.browser_download_url;
    link.append(size);
    row.append(link);

    return row;
}

function video_embed() {
    const section = document.getElementById('video');

    if (section === null) return;
    if (section.dataset.youtube === '') return;

    const id = section.dataset.youtube;
    const player = document.createElement('iframe');

    assert(section.hidden, 'the video section starts hidden');
    assert(youtube_id_pattern.test(id), `${id} is not an eleven character YouTube video id`);

    player.src = `https://www.youtube-nocookie.com/embed/${id}`;
    player.title = 'Remi Remembers pitch video';
    player.loading = 'lazy';
    player.allow = 'autoplay; encrypted-media; picture-in-picture; web-share';
    player.allowFullscreen = true;
    player.referrerPolicy = 'strict-origin-when-cross-origin';
    section.append(player);
    section.hidden = false;
}
