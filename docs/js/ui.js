// Small DOM helpers. All text goes in through textContent, so names and notes
// from a link or from the chain can never become markup.

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' || key === 'disabled' || key === 'checked') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  add(el, kids);
  return el;
}

function add(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

export function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) el.setAttribute(key, String(value));
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

const ICONS = {
  seed: 'M12 21v-7M12 14c0-4 3-7 8-7 0 5-3 7-8 7ZM12 16c0-3-2.5-5.5-7-5.5 0 4 2.5 5.5 7 5.5Z',
  home: 'M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-8Z',
  bike: 'M5.5 18a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM18.5 18a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM5.5 14.5h6l3.5-7h-5M15 7.5h3l.5 7',
  laptop: 'M5 6h14a1 1 0 0 1 1 1v9H4V7a1 1 0 0 1 1-1ZM2 19h20',
  school: 'M12 5 2 10l10 5 10-5-10-5ZM6 12.5V17c2 2 10 2 12 0v-4.5',
  plane: 'M21 3 3 10.5l6.5 2.5L12 20l9-17ZM9.5 13 21 3',
  heart: 'M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11Z',
  gift: 'M4 10h16v10H4V10ZM2.5 6.5h19V10h-19V6.5ZM12 6.5V20M12 6.5C10.5 3 6.5 3 7 5.5c.3 1 2.5 1 5 1ZM12 6.5c1.5-3.5 5.5-3.5 5-1-.3 1-2.5 1-5 1Z',
  check: 'M5 13l4 4L19 7',
  close: 'M6 6l12 12M18 6 6 18',
  back: 'M15 5l-7 7 7 7',
  next: 'M9 5l7 7-7 7',
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 13.5l1.6 1.2-2 3.4-1.9-.8a7 7 0 0 1-1.9 1.1L15 20.5h-4l-.2-2.1a7 7 0 0 1-1.9-1.1l-1.9.8-2-3.4 1.6-1.2a7 7 0 0 1 0-2.9L5 9.3l2-3.4 1.9.8a7 7 0 0 1 1.9-1.1L11 3.5h4l.2 2.1a7 7 0 0 1 1.9 1.1l1.9-.8 2 3.4-1.6 1.2a7 7 0 0 1 0 2.9Z',
  share: 'M12 15V3M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7',
  flame: 'M12 3c.5 3.2 2.1 4.7 3.700 6.5C17.1 11.1 18 12.7 18 14.7 18 18.2 15.3 21 12 21s-6-2.8-6-6.3c0-1.8.8-3.3 2-4.5.2 1.500 1 2.500 2.200 2.9C9.700 9.3 10.3 5.7 12 3Z',
  plus: 'M12 5v14M5 12h14',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01',
};

export const GOAL_ICONS = ['seed', 'home', 'bike', 'laptop', 'school', 'plane', 'heart', 'gift'];

export function icon(name, size = 22) {
  return svg('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    svg('path', { d: ICONS[name] || ICONS.seed }));
}

const HEX = 'M50 4.5a7 7 0 0 1 3.5.9l34.8 20.1a7 7 0 0 1 3.5 6v37a7 7 0 0 1-3.5 6L53.5 94.6a7 7 0 0 1-7 0L11.7 74.5a7 7 0 0 1-3.5-6v-37a7 7 0 0 1 3.5-6L46.5 5.4a7 7 0 0 1 3.5-.9Z';

/** The progress ring: a hexagon that fills as the goal does. */
export function hexRing(ratio, size, inner, { track = 'var(--ring-track)', stroke = 'url(#kz-gold)', width = 7 } = {}) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  const s = svg('svg', { viewBox: '0 0 100 100', width: size, height: size, 'aria-hidden': 'true' },
    svg('path', { d: HEX, fill: 'none', stroke: track, 'stroke-width': width }),
    pct > 0 ? svg('path', { d: HEX, fill: 'none', stroke, 'stroke-width': width, 'stroke-linecap': 'round', pathLength: 100, 'stroke-dasharray': `${pct.toFixed(2)} 100` }) : null);
  return h('div', { class: 'hex', style: `width:${size}px;height:${size}px` }, s, h('div', { class: 'hex-in' }, inner));
}

export function logo(size = 30) {
  return svg('svg', { viewBox: '0 0 100 100', width: size, height: size, 'aria-hidden': 'true' },
    svg('path', { d: HEX, fill: 'url(#kz-gold)' }),
    svg('path', { d: 'M50 73V50M50 50c0-13 9-21 23-21 0 15-9 21-23 21ZM50 57c0-10-7-16-19-16 0 12 7 16 19 16Z', fill: 'none', stroke: '#1f2348', 'stroke-width': 6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
}

let sheetEl = null;
let onSheetClose = null;

export function openSheet(title, body, { onClose, sub } = {}) {
  closeSheet(true);
  const root = document.getElementById('sheet');
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' },
      h('div', {}, h('h2', {}, title), sub ? h('p', { class: 'mute small' }, sub) : null),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', 'data-rig': 'sheet-close', onclick: () => closeSheet() }, icon('close'))),
    h('div', { class: 'sheet-body' }, body));
  const shade = h('div', { class: 'shade', onclick: (e) => { if (e.target === shade) closeSheet(); } }, panel);
  root.append(shade);
  sheetEl = shade;
  onSheetClose = onClose || null;
  document.body.classList.add('no-scroll');
  return panel;
}

export function closeSheet(silent) {
  if (!sheetEl) return;
  sheetEl.remove();
  sheetEl = null;
  document.body.classList.remove('no-scroll');
  const cb = onSheetClose;
  onSheetClose = null;
  if (cb && !silent) cb();
}

export const sheetOpen = () => Boolean(sheetEl);

let toastTimer = null;

export function toast(text, kind = 'info', ms = 3600) {
  const root = document.getElementById('toast');
  root.replaceChildren(h('div', { class: `toast ${kind}`, role: 'status' }, text));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => root.replaceChildren(), ms);
}

/** Copy text. Clipboard API first, then the old way; tells the caller if either worked. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0;top:0', readonly: true });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch { /* fall through */ }
    ta.remove();
    return ok;
  }
}
