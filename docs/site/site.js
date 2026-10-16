// popcornpals landing page. Voodoo.js (https://kwy404.github.io/Voodoo.js/)
// runs the declared parts: the theme toggle, the ticket tabs and the copy
// button. It is loaded with data-manual and started here. This module adds
// the two scroll effects: the curtains of the hero open as the page scrolls,
// and the frames of each reel advance into the gate as they come into view.

const root = document.documentElement;
const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const still = () => reduced?.matches ?? false;

let started = false;
function startVoodoo() {
  const V = window.V;
  if (started || !V) return;
  started = true;
  V.start();
}

// The browser bar follows the theme, dark by default.
function paintThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = root.getAttribute('data-theme') === 'light' ? '#F5F3EF' : '#0A0A0B';
}

// ------------------------------------------------------------------- hero
// --p goes from 0 (curtains over the edges of the screen) to 1 (gathered at
// the sides) over the first stretch of scrolling, while the stage is pinned.
const hero = document.querySelector('.cinema');
const stage = hero?.querySelector('.stage');
let queued = false;

function paintHero() {
  queued = false;
  if (!hero || !stage) return;
  if (still() || !root.classList.contains('scrolly')) {
    stage.style.removeProperty('--p');
    return;
  }
  const range = hero.offsetHeight - stage.offsetHeight;
  const scrolled = hero.offsetTop - hero.getBoundingClientRect().top;
  const t = range > 0 ? Math.min(1, Math.max(0, scrolled / range)) : 1;
  const eased = t * t * (3 - 2 * t);
  stage.style.setProperty('--p', eased.toFixed(4));
}

function queueHero() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(paintHero);
}

function setScrolly() {
  root.classList.toggle('scrolly', Boolean(hero) && !still());
  queueHero();
}

// ------------------------------------------------------------------ reels
// Each frame starts below its place, dim, and moves into the gate when it is
// seen. The sprocket holes of its strip run up by the same beat.
function armReels() {
  const frames = [...document.querySelectorAll('.strip .frame')];
  if (!frames.length || still() || !('IntersectionObserver' in window)) return;
  root.classList.add('armed');
  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const frame = entry.target;
        frame.classList.add('is-in');
        seen.unobserve(frame);
        const strip = frame.closest('.strip');
        if (!strip) continue;
        const shown = strip.querySelectorAll('.frame.is-in').length;
        const hole = (frame.offsetLeft || 32) * 0.8;
        strip.style.setProperty('--sprocket-y', `${-Math.round(shown * 6 * hole)}px`);
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.08 },
  );
  for (const frame of frames) seen.observe(frame);
  // A visitor who turns on reduced motion mid-visit gets every frame at once.
  reduced?.addEventListener?.('change', () => {
    if (!still()) return;
    for (const frame of frames) frame.classList.add('is-in');
  });
}

function boot() {
  startVoodoo();
  paintThemeColor();
  document.addEventListener('voodoo:theme', paintThemeColor);
  new MutationObserver(paintThemeColor).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  setScrolly();
  addEventListener('scroll', queueHero, { passive: true });
  addEventListener('resize', queueHero);
  reduced?.addEventListener?.('change', setScrolly);
  armReels();
}

// Voodoo is a deferred classic script, so it has run by the time this module
// does; wait for the load event anyway in case the CDN is slow.
if (window.V) boot();
else {
  addEventListener('load', boot, { once: true });
}
