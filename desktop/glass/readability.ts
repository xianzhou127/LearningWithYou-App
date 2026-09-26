import type { Rect } from './contract';

export const READING_SELECTORS = ['.toolbar-status', '.learning-primary', '.toolbar-feedback', '.toolbar-more', '.toolbar-grip'] as const;
export const READING_REGION_COUNT = READING_SELECTORS.length;

// Layout numbers only. No canvas/image readback and no per-frame DOM reads.
// offset geometry ignores the capsule's drag transform and button press scale.
export function readingRects(shell: HTMLElement): Rect[] {
  return READING_SELECTORS.flatMap(selector => {
    const node = shell.querySelector<HTMLElement>(selector);
    if (!node || !node.offsetWidth || !node.offsetHeight) return [];
    let x = 0, y = 0, current: HTMLElement | null = node;
    while (current && current !== shell) { x += current.offsetLeft; y += current.offsetTop; current = current.offsetParent as HTMLElement | null; }
    if (current !== shell) return [];
    const ink: DOMRect[] = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.textContent?.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(text);
      ink.push(range.getBoundingClientRect());
    }
    node.querySelectorAll('svg,.state-dot').forEach(icon => ink.push(icon.getBoundingClientRect()));
    if (!ink.length) return [];
    // Tight text/icon bounds leave the empty part of a wide button transparent.
    // Undo transforms for measurement: press and drag must not move the mask.
    const outer = node.getBoundingClientRect(), sx = outer.width / node.offsetWidth, sy = outer.height / node.offsetHeight;
    const left = Math.max(0, (Math.min(...ink.map(r => r.left)) - outer.left) / sx);
    const top = Math.max(0, (Math.min(...ink.map(r => r.top)) - outer.top) / sy);
    const right = Math.min(node.offsetWidth, (Math.max(...ink.map(r => r.right)) - outer.left) / sx);
    const bottom = Math.min(node.offsetHeight, (Math.max(...ink.map(r => r.bottom)) - outer.top) / sy);
    return [{ x: x + left, y: y + top, width: right - left, height: bottom - top }];
  });
}
export function observeReadingLayout(shell: HTMLElement, update: (rects: Rect[]) => void) {
  let previous = '';
  const publish = () => {
    const rects = readingRects(shell), key = JSON.stringify(rects);
    shell.dataset.readingReady = String(rects.length === READING_REGION_COUNT);
    if (key !== previous) { previous = key; update(rects); }
  };
  const resize = new ResizeObserver(publish);
  const children = new MutationObserver(() => { attach(); publish(); });
  const attach = () => { resize.disconnect(); for (const selector of READING_SELECTORS) { const node = shell.querySelector(selector); if (node) resize.observe(node); } };
  children.observe(shell, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'data-reading'] });
  attach(); publish();
  return () => { resize.disconnect(); children.disconnect(); };
}

// Changes only CSS foreground on the existing React controls.
export function applyInkTones(shell: HTMLElement, tones: readonly ('dark' | 'light')[] | null) {
  READING_SELECTORS.forEach((selector, i) => {
    const node = shell.querySelector<HTMLElement>(selector);
    if (!node) return;
    if (tones?.[i]) node.dataset.ink = tones[i]; else delete node.dataset.ink;
  });
}
