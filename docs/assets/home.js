const hero = document.querySelector('.hero');
const stage = document.getElementById('stage');
const scene = document.getElementById('scene');

assert(hero !== null, 'the page has no hero');
assert(stage !== null, 'the hero has no stage');
assert(scene !== null, 'the stage has no scene');

stage_fit();
hero.classList.add('ready');
new ResizeObserver(stage_fit).observe(stage);
new IntersectionObserver(stage_watch).observe(stage);

function assert(condition, message) {
    console.assert(typeof condition === 'boolean', 'assert expects a boolean condition');
    console.assert(typeof message === 'string', 'assert expects a message');

    if (condition) return;

    throw new Error(message);
}

function stage_fit() {
    const width = stage.clientWidth;
    const design = scene.offsetWidth;

    assert(design > 0, 'the scene has no design width');

    if (width === 0) return;

    const scale = width / design;

    assert(Number.isFinite(scale), 'the scene scale is not a number');
    assert(scale > 0, 'the scene scale is not positive');

    scene.style.setProperty('--scale', String(scale));
}

function stage_watch(entries) {
    assert(entries.length > 0, 'the stage watcher fired without an entry');
    assert(entries.every((entry) => entry.target === stage), 'the watcher saw more than the stage');

    const entry = entries[entries.length - 1];

    if (entry.isIntersecting) {
        hero.classList.remove('paused');
    } else {
        hero.classList.add('paused');
    }
}
