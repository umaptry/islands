// Locally bundled line icons. Geometry follows Lucide (ISC license, see LICENSE-icons).
const paths = {
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  filter: '<path d="M3 6h6m4 0h8M3 12h12m4 0h2M3 18h2m4 0h12M9 3v6m6 0v6M5 15v6"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  back: '<path d="m12 19-7-7 7-7M5 12h14"/>',
  message: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 3V11.5a10 10 0 0 1 20 0Z"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  help: '<path d="M2 12h3l4-3h4a2 2 0 0 1 0 4h-3m3 0 6-4a2 2 0 0 1 3 3l-7 6H5l-3-1M2 10v10"/><path d="M14 6c-5-3 0-7 2-3 2-4 7 0 2 3l-2 2Z"/>',
  hand: '<path d="M8 13V5a2 2 0 0 1 4 0v7-9a2 2 0 0 1 4 0v9-7a2 2 0 0 1 4 0v10a7 7 0 0 1-12 5l-6-6a2 2 0 0 1 3-3l3 2"/>',
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  send: '<path d="m22 2-7 20-4-9L2 9 20 2ZM22 2 11 13"/>',
};

export function icon(name, size = 22) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size,
    fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round',
    'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
  svg.innerHTML = paths[name] || paths.more;
  return svg;
}

export function setupIcons() {
  const ids = { composeBack: 'back', editBack: 'back', userBack: 'back', composeImageBtn: 'image',
    composeImageClear: 'close', mapSearchClear: 'close', sheetClose: 'close', mapRecenter: 'pin' };
  Object.entries(ids).forEach(([id, name]) => document.getElementById(id)?.replaceChildren(icon(name)));
  document.querySelector('.search-icon')?.replaceChildren(icon('search', 18));
  document.querySelector('#mapFilterBtn > span')?.replaceChildren(icon('filter', 20));
  document.querySelectorAll('.nav-item').forEach((button, i) => {
    button.setAttribute('aria-label', button.querySelector('.nav-label').textContent);
    button.querySelector('.nav-icon').replaceChildren(icon(['map', 'plus', 'bell', 'user'][i], 28));
  });
}
