// Tiny DOM helpers shared by the popup and the options page. Everything goes through
// textContent / text nodes / setAttribute with fixed names, never innerHTML.

const SVG_NS = 'http://www.w3.org/2000/svg';

export const ICONS = {
  plus: ['M12 5v14', 'M5 12h14'],
  bell: ['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.73 21a2 2 0 0 1-3.46 0'],
  repeat: ['M17 1l4 4-4 4', 'M3 11V9a4 4 0 0 1 4-4h14', 'M7 23l-4-4 4-4', 'M21 13v2a4 4 0 0 1-2 2H3'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6', 'M14 11v6'],
  clock: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M12 6v6l4 2'],
  calendar: ['M3 4h18v18H3z', 'M16 2v4', 'M8 2v4', 'M3 10h18'],
  pencil: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z'],
  sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  back: ['M19 12H5', 'M12 19l-7-7 7-7'],
  x: ['M18 6L6 18', 'M6 6l12 12'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
  check: ['M20 6L9 17l-5-5'],
};

/**
 * h(doc, 'div', {class: 'x', dataset: {id: 1}}, child, 'text', [more]) -> Element.
 * false/null/undefined props and children are skipped; `true` makes a boolean attribute.
 */
export function createH(doc) {
  return function h(tag, props = {}, ...children) {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(typeof c === 'object' ? c : doc.createTextNode(String(c)));
    }
    return node;
  };
}

export function createIcon(doc) {
  return function icon(name) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    const attrs = {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    for (const d of ICONS[name]) {
      const p = doc.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  };
}
