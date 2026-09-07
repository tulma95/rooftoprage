export const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export const button = (action: string, label: string, cls = '', disabled = false) =>
  `<button data-action="${action}" class="${cls}" ${disabled ? 'disabled' : ''}>${label}</button>`;
export const tag = (text: string) => `<span class="eyebrow">${text}</span>`;
