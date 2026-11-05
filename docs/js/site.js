// Small extras for the landing page in a normal browser. The page is complete without this file (readers without
// JavaScript get every word, the hero frame rests at the demo's end and every step is shown); it only runs when the landing
// page is showing, never inside Nimiq Pay. Nothing here animates layout: it sets classes and data attributes that CSS
// turns into transform and opacity changes.

const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function copyButtons(page) {
  for (const b of page.querySelectorAll('[data-copy]')) {
    b.hidden = false;
    let t = 0;
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        b.classList.add('done');
        b.setAttribute('aria-label', 'Copied');
        clearTimeout(t);
        t = setTimeout(() => { b.classList.remove('done'); b.setAttribute('aria-label', b.dataset.label); }, 1600);
      } catch { /* clipboard blocked: the text is on the page to select */ }
    });
    b.dataset.label = b.getAttribute('aria-label');
  }
}

// Light or dark: follows the system until the visitor picks one; the pick is remembered (index.html restores it before paint).
function themeToggle(page) {
  const btn = page.querySelector('#theme');
  if (!btn) return;
  const root = document.documentElement;
  const sys = window.matchMedia('(prefers-color-scheme: dark)');
  const now = () => root.dataset.theme || (sys.matches ? 'dark' : 'light');
  const label = () => {
    const dark = now() === 'dark';
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.setAttribute('aria-pressed', String(dark));
  };
  btn.hidden = false;
  label();
  sys.addEventListener?.('change', label);
  btn.addEventListener('click', () => {
    const next = now() === 'dark' ? 'light' : 'dark';
    const apply = () => {
      root.dataset.theme = next;
      try { localStorage.setItem('kuza.theme', next); } catch { /* private mode: the choice lasts for this page */ }
      label();
    };
    // A view transition cross-fades the two themes where the browser has it; the change happens either way.
    if (document.startViewTransition && !reduce()) document.startViewTransition(apply);
    else apply();
  });
}

// The hero demo plays once on load in CSS; Replay restarts it from the first frame.
function hero(page) {
  const live = page.querySelector('#live');
  const replay = page.querySelector('#replay');
  if (!live || !replay) return;
  replay.hidden = false;
  replay.addEventListener('click', () => {
    live.classList.add('lp-wait');
    void live.offsetWidth; // restart the CSS animations from the first frame
    live.classList.remove('lp-wait');
  });
}

// How it works: the step nearest the middle of the screen is the one the phone shows, and the stem grows to it.
function steps(page) {
  const sec = page.querySelector('#how');
  if (!sec || !('IntersectionObserver' in window)) return;
  const items = [...sec.querySelectorAll('.lp-step')];
  const set = (n) => {
    if (sec.dataset.step === String(n)) return;
    sec.dataset.step = String(n);
    items.forEach((li, i) => {
      li.classList.toggle('on', i + 1 === n);
      li.classList.toggle('done', i + 1 < n);
    });
  };
  set(1);
  const io = new IntersectionObserver((seen) => {
    for (const e of seen) if (e.isIntersecting) set(Number(e.target.dataset.n));
  }, { rootMargin: window.matchMedia('(min-width: 1024px)').matches ? '-45% 0px -45% 0px' : '-70% 0px -24% 0px' });
  items.forEach((li) => io.observe(li));
}

// Mainnet record: the meter shows the test stake after the transaction nearest the middle of the screen.
// These are the real balances from the chain; the page's static copy shows the end state.
function ledger(page) {
  const sec = page.querySelector('#record');
  const meter = page.querySelector('.lp-meter');
  if (!sec || !meter || !('IntersectionObserver' in window)) return;
  const rows = [...sec.querySelectorAll('.lp-tx')];
  const out = { active: page.querySelector('#m-active'), cool: page.querySelector('#m-cool'), gift: page.querySelector('#m-gift'), back: page.querySelector('#m-back') };
  const fmt = new Intl.NumberFormat('en');
  const shown = { active: 1100, cool: 0, gift: 0, back: 60 };
  let raf = 0;
  const tick = (to) => {
    cancelAnimationFrame(raf);
    const from = { ...shown };
    const start = performance.now();
    const dur = reduce() ? 0 : 600;
    const step = (now) => {
      const k = dur ? Math.min(1, (now - start) / dur) : 1;
      const e = 1 - Math.pow(1 - k, 3);
      for (const key of Object.keys(out)) {
        shown[key] = Math.round(from[key] + (to[key] - from[key]) * e);
        if (out[key]) out[key].textContent = fmt.format(shown[key]);
      }
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    meter.style.setProperty('--a', to.active);
    meter.style.setProperty('--c', to.cool);
  };
  const io = new IntersectionObserver((seen) => {
    for (const e of seen) {
      if (!e.isIntersecting) continue;
      const li = e.target;
      rows.forEach((r) => r.classList.toggle('on', r === li));
      const d = li.dataset;
      tick({ active: +d.active, cool: +d.cool, gift: +d.gift, back: +d.back });
    }
  }, { rootMargin: '-48% 0px -48% 0px' });
  rows.forEach((r) => io.observe(r));
  const ol = sec.querySelector('.lp-ledger');
  const run = () => ol && ol.style.setProperty('--run', `${Math.max(0, ol.offsetHeight - 68)}px`);
  run();
  window.addEventListener('resize', run, { passive: true });
}

// The diagram pulses in #jar and the ledger run once when their section comes into view (hovering the diagram runs it again).
function playWhenSeen(page) {
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((seen) => {
    for (const e of seen) if (e.isIntersecting) { e.target.classList.add('lp-go'); io.unobserve(e.target); }
  }, { threshold: 0.35 });
  for (const el of page.querySelectorAll('#jar, #record')) io.observe(el);
}

// Phones: the bar with the two actions shows once the hero's own buttons have scrolled away.
function actionBar(page) {
  const bar = page.querySelector('.lp-bar');
  const cta = page.querySelector('.lp-hero .lp-cta');
  if (!bar || !cta || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver(([e]) => bar.classList.toggle('lp-away', e.isIntersecting), { threshold: 0 });
  io.observe(cta);
}

function navLine(page) {
  const nav = page.querySelector('.lp-nav');
  if (!nav) return;
  const on = () => nav.classList.toggle('lp-scrolled', window.scrollY > 8);
  on();
  window.addEventListener('scroll', on, { passive: true });
}

export function start(page) {
  for (const f of [copyButtons, themeToggle, hero, steps, ledger, playWhenSeen, actionBar, navLine]) {
    try { f(page); } catch { /* one extra failing never takes the others down */ }
  }
}
