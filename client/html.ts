export const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export const button = (action: string, label: string, cls = '', disabled = false) =>
  `<button data-action="${action}" class="${cls}" ${disabled ? 'disabled' : ''}>${label}</button>`;
export const tag = (text: string) => `<span class="eyebrow">${text}</span>`;

// Bold 24-unit weapon glyphs in one style: filled silhouettes plus 2.6-wide round strokes, currentColor.
const f = (d: string) => `<path d="${d}"/>`;
const s = (d: string) =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
const saw = (() => {
  let d = '';
  for (let i = 0; i < 24; i++) {
    const a = (i * Math.PI) / 12,
      r = i % 2 ? 8.2 : 11.4;
    d += `${i ? 'L' : 'M'}${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`;
  }
  return `<path fill-rule="evenodd" d="${d}ZM12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Z"/>`;
})();
const ICONS: Record<string, string> = {
  ram: f('M2 10h10v4H2z') + f('M12 3.5h5.5l3 3v11l-3 3H12z') + s('M23 8.5v7'),
  wedge: f('M1.5 20.5h21V5z') + s('M3 8h6M3 12.5h3'),
  sweeper:
    f('M6 21a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 6 21z') +
    s('M6 17.8 20 7.5') +
    s('M8.5 3.5A15 15 0 0 1 21 13.5'),
  flipper: f('M2 19.5h20V22H2z') + f('M7 19.5 20 10l2 2.8-9 6.7z') + s('M6 14V4M3 7l3-3 3 3'),
  hook: s('M9 2.5v10.5a5 5 0 0 0 10 0v-1.5') + f('M15.8 12.5 19 6.5l3.2 6z') + s('M5.5 2.5h7'),
  saw,
  hammer: f('M2.5 3.5h13l3.5 3.5v4H2.5z') + f('M8 11h3.6v11H8z') + s('M21.5 3v2M22 8.5h1'),
  drill:
    f('M1.5 7.5h5.5v9H1.5z') +
    f('M8 6.5l4.2 1.6v7.8L8 17.5z') +
    f('M13.4 8.6l4 1.5v3.8l-4 1.5z') +
    f('M18.6 10.5 23 12l-4.4 1.5z'),
  cannon:
    f('M2 21a7.5 7.5 0 0 1 15 0z') +
    f('M9.4 13.2 19.2 4.2l3.2 3.4-9.8 9z') +
    f('M4.5 22h10v1.5h-10z'),
  scattergun:
    f('M1.5 10h8v4h-8z') +
    [
      [15, 5],
      [20, 8.5],
      [15.5, 12],
      [20.5, 15.5],
      [15, 19],
    ]
      .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.1"/>`)
      .join(''),
  railgun:
    f('M1.5 4.5h13l3.5 4h-16.5zM1.5 19.5h13l3.5-4h-16.5z') + s('M4 12h18.5') + f('M8 9.6h3v4.8H8z'),
  flamethrower:
    '<path fill-rule="evenodd" d="M12.5 1.5c.8 4.4 6.5 6.5 6.5 12.8a7 7 0 0 1-14 0c0-3.3 2-5.5 3.3-6.8 0 2.3.9 3.6 2.2 3.8C10 8 11 4.4 12.5 1.5zM12 13.6c-1.3 1.6-2.4 2.8-2.4 4.4a2.4 2.4 0 0 0 4.8 0c0-1.6-1.1-2.8-2.4-4.4z"/>',
  burst: f('M2 4.5h4.6l7.2 7.5-7.2 7.5H2L9.2 12zM10.2 4.5h4.6l7.2 7.5-7.2 7.5h-4.6l7.2-7.5z'),
};
/** Inline SVG weapon/ability glyph sized to 1em, inheriting currentColor. */
export const icon = (key: string) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICONS[key] ?? ''}</svg>`;
