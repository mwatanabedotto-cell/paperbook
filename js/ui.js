// Utilidades de interfaz: iconos, avisos, menús y diálogos.
const P = {
  back: 'M15 5l-7 7 7 7',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  undo: 'M9 7L4 12l5 5M4 12h10a6 6 0 0 1 0 12h-2',
  redo: 'M15 7l5 5-5 5M20 12H10a6 6 0 0 0 0 12h2',
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5a1.5 1.5 0 0 1 3 0V11m0-5a1.5 1.5 0 0 1 3 0v6m0-3.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1.5a6 6 0 0 1-4.6-2.2L3.6 15a1.6 1.6 0 0 1 2.5-2L8 15',
  pen: 'M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1zM14 7l3 3',
  hl: 'M9 14l-3 3v3h3l3-3M9 14l8-9 4 4-9 8M9 14l3 3M3 21h18',
  eraser: 'M7 20l-4-4a2 2 0 0 1 0-2.8L13.2 3a2 2 0 0 1 2.8 0l5 5a2 2 0 0 1 0 2.800L11 20H7zM9 8l7 7M11 20h10',
  line: 'M5 19L19 5',
  arrow: 'M5 19L19 5M10 5h9v9',
  rect: 'M4 6h16v12H4z',
  ellipse: 'M12 5c5 0 9 3.100 9 7s-4 7-9 7-9-3.100-9-7 4-7 9-7z',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  cloud: 'M7 18a4.5 4.5 0 0 1-.6-8.960A6 6 0 0 1 18 10.500 3.800 3.800 0 0 1 17.500 18H7z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.500 2.500 3.500 5.500 3.500 9s-1 6.500-3.500 9c-2.500-2.500-3.500-5.500-3.500-9s1-6.500 3.500-9z',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9h.01',
  canvas: 'M4 4h16v13H4zM9 21l3-4 3 4M7 13c2-5 4 2 6-3 1-2 2-1 3 0',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16v4z',
  folder: 'M3 6h6l2 2h10v11H3z',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  link: 'M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12l2-1-2-4-2 .600-1.700-1L15 4H9l-.300 2.600-1.700 1L5 7l-2 4 2 1v0l-2 1 2 4 2-.600 1.700 1L9 20h6l.300-2.600 1.700-1 2 .600 2-4-2-1z',
  finger: 'M9 11V4.500a1.500 1.500 0 0 1 3 0V11l5 1a2 2 0 0 1 1.600 2.300L18 19a3 3 0 0 1-3 2.500h-3.500a4 4 0 0 1-3.300-1.700L5 15.500a1.500 1.500 0 0 1 2.300-1.900L9 15',
  page: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h3',
};

export const icon = (name) =>
  `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[name] || ''}"/></svg>`;

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...children.filter((c) => c != null));
  return n;
}

let toastBox;
export function toast(msg, { error = false, ms = 3200 } = {}) {
  toastBox ||= document.body.appendChild(el('div', { class: 'toasts', 'aria-live': 'polite' }));
  const t = el('div', { class: 'toast' + (error ? ' error' : '') }, msg);
  toastBox.append(t);
  const close = () => t.remove();
  if (ms) setTimeout(close, ms);
  return { close, set: (m) => (t.textContent = m) };
}

/** Menú emergente anclado a un elemento. */
export function menu(anchor, items) {
  document.querySelector('.menu')?.remove();
  const m = el('div', { class: 'menu', role: 'menu' });
  for (const it of items.filter(Boolean)) {
    if (it === '-') { m.append(el('hr')); continue; }
    m.append(el('button', {
      class: it.danger ? 'danger' : '', role: 'menuitem',
      html: (it.icon ? icon(it.icon) : '') + `<span></span>`,
      onclick: () => { close(); it.onClick(); },
    }));
    m.lastChild.querySelector('span').textContent = it.label;
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + 'px';
  m.style.top = (r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
  const off = (e) => { if (!m.contains(e.target)) close(); };
  function close() {
    m.remove();
    document.removeEventListener('pointerdown', off, true);
  }
  setTimeout(() => document.addEventListener('pointerdown', off, true));
}

/** Diálogo modal genérico. `build(dlg, close)` rellena el contenido. */
export function dialog(title, build) {
  return new Promise((resolve) => {
    const d = el('dialog', { class: 'dlg' });
    const close = (v) => { d.close(); d.remove(); resolve(v); };
    d.append(el('h2', {}, title));
    build(d, close);
    d.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    d.addEventListener('click', (e) => { if (e.target === d) close(null); });
    document.body.append(d);
    d.showModal();
  });
}

export function askText(title, { value = '', placeholder = '', ok = 'Guardar', hint = '', type = 'text' } = {}) {
  return dialog(title, (d, close) => {
    const input = el('input', { type, value, placeholder, autocomplete: 'off' });
    const form = el('form', { onsubmit: (e) => { e.preventDefault(); close(input.value.trim()); } },
      hint ? el('p', { class: 'hint' }, hint) : null,
      input,
      el('div', { class: 'row end' },
        el('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'Cancelar'),
        el('button', { type: 'submit', class: 'btn primary' }, ok)));
    d.append(form);
    setTimeout(() => input.select());
  });
}

export function askConfirm(title, text, ok = 'Eliminar') {
  return dialog(title, (d, close) => {
    d.append(el('p', {}, text),
      el('div', { class: 'row end' },
        el('button', { class: 'btn', onclick: () => close(false) }, 'Cancelar'),
        el('button', { class: 'btn danger', onclick: () => close(true) }, ok)));
  });
}
