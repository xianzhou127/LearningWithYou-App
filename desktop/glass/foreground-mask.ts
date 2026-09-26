import { SIZE, type Rect } from './contract';

// These are paint groups, not business state. Every visible toolbar glyph is
// sourced from the existing React DOM, including the nested context button.
export const FOREGROUND_GROUPS = ['.toolbar-state', '.toolbar-context', '.learning-primary', '.toolbar-feedback', '.toolbar-more', '.toolbar-grip'] as const;
export type MaskGroup = Rect & { scaleX: number; scaleY: number; dx: number; dy: number; opacity?: number };
export type MaskFrame = { canvas: HTMLCanvasElement; revision: number; groups: MaskGroup[]; textRuns: number; icons: number; dots: number; outlines: number };
export interface MaskSource { frame(): MaskFrame; readonly animating: boolean; visible(value: boolean): void; density?(dpr: number): void; prepareDensities?(dprs: number[]): void }

function localRect(node: HTMLElement, shell: HTMLElement): Rect {
  let x = 0, y = 0, current: HTMLElement | null = node;
  while (current && current !== shell) { x += current.offsetLeft; y += current.offsetTop; current = current.offsetParent as HTMLElement | null; }
  for (let parent = node.parentElement; parent && parent !== shell; parent = parent.parentElement) { x -= parent.scrollLeft; y -= parent.scrollTop; }
  return { x, y, width: node.offsetWidth, height: node.offsetHeight };
}
function fontString(css: CSSStyleDeclaration) { return `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`; }

// Rasterizes only local UI glyphs, never captured video or the glass canvas.
// Direct Canvas -> WebGL upload; no image serialization or pixel readback.
export class ForegroundMask implements MaskSource {
  private dirty = true;
  private revision = 0;
  private painted = -1;
  private densityValue = 1;
  private atlases = new Map<string, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; result: MaskFrame; painted: number }>();
  private disposed = false;
  private wasAnimating = false;
  motion: (() => import('./motion').MotionPose) | undefined;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private nodes: HTMLElement[] = [];
  private result: MaskFrame;
  private observer: MutationObserver;
  private resize: ResizeObserver;
  private invalidate = () => { if (!this.disposed) { this.dirty = true; this.revision++; this.wake(); } };
  private events = ['pointerover', 'pointerout', 'pointerdown', 'pointerup', 'pointercancel', 'focusin', 'focusout', 'transitionrun', 'transitionend', 'scroll'];
  constructor(private shell: HTMLElement, private wake: () => void, dpr = devicePixelRatio, private size: { width: number; height: number } = SIZE, private select?: () => HTMLElement[]) {
    this.densityValue = dpr;
    this.canvas.width = Math.round(this.size.width * dpr); this.canvas.height = Math.round(this.size.height * dpr);
    this.ctx = this.canvas.getContext('2d')!;
    this.result = { canvas: this.canvas, revision: 0, groups: [], textRuns: 0, icons: 0, dots: 0, outlines: 0 };
    this.resize = new ResizeObserver(this.invalidate);
    this.observer = new MutationObserver(records => {
      if (records.some(r => r.type !== 'attributes' || r.target !== shell)) this.invalidate();
    });
    this.observer.observe(shell, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'disabled', 'aria-expanded'] });
    this.events.forEach(event => shell.addEventListener(event, this.invalidate, true));
    document.fonts.addEventListener('loadingdone', this.invalidate);
    void document.fonts.ready.then(this.invalidate);
  }
  get animating() { return !this.disposed && (this.motion ? this.motion().active : this.shell.getAnimations({ subtree: true }).some(a => a.playState === 'running')); }
  visible(value: boolean) { this.shell.dataset.fieldReady = String(value); }
  density(dpr: number) {
    this.densityValue = dpr;
    const width = Math.round(this.size.width * dpr), height = Math.round(this.size.height * dpr);
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.atlases.set(`${this.canvas.width}x${this.canvas.height}`, { canvas: this.canvas, ctx: this.ctx, result: this.result, painted: this.painted });
    let next = this.atlases.get(`${width}x${height}`);
    if (!next) { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; next = { canvas, ctx: canvas.getContext('2d')!, result: { canvas, revision: 0, groups: [], textRuns: 0, icons: 0, dots: 0, outlines: 0 }, painted: -1 }; }
    this.canvas = next.canvas; this.ctx = next.ctx; this.result = next.result; this.painted = next.painted; this.dirty = this.painted !== this.revision;
  }
  prepareDensities(dprs: number[]) { const current = this.densityValue; for (const dpr of dprs) { this.density(dpr); this.frame(); } this.density(current); }
  frame() {
    const repainted = this.dirty;
    if (repainted) this.paint();
    // Read transforms only during active press/pulse animations. The glyph
    // atlas stays unchanged; the shader transforms each group around its centre.
    const active = this.animating;
    if (this.motion || active || this.wasAnimating || repainted) this.result.groups.forEach((g, i) => {
      if (this.motion) { const pose = this.motion(); g.scaleX = g.scaleY = pose.scales[i]; g.dx = pose.offsetsX[i]; g.dy = pose.offsetsY[i]; g.opacity = pose.opacity[i]; return; }
      const transform = getComputedStyle(this.nodes[i]).transform;
      const m = transform === 'none' ? null : new DOMMatrixReadOnly(transform);
      g.scaleX = m?.a ?? 1; g.scaleY = m?.d ?? 1; g.dx = m?.e ?? 0; g.dy = m?.f ?? 0;
    });
    this.wasAnimating = active;
    return this.result;
  }
  private paint() {
    this.dirty = false;
    this.painted = this.revision;
    const nodes = this.select?.() ?? FOREGROUND_GROUPS.map(s => this.shell.querySelector<HTMLElement>(s));
    if (nodes.some(n => !n)) { this.result.groups = []; return; }
    if (nodes.some((n, i) => n !== this.nodes[i])) {
      this.nodes = nodes as HTMLElement[]; this.resize.disconnect(); this.nodes.forEach(n => this.resize.observe(n));
    }
    const c = this.ctx, sx = this.canvas.width / this.size.width, sy = this.canvas.height / this.size.height;
    c.resetTransform(); c.clearRect(0, 0, this.canvas.width, this.canvas.height); c.scale(sx, sy);
    this.result.textRuns = this.result.icons = this.result.dots = this.result.outlines = 0;
    this.result.groups = this.nodes.map(node => {
      const box = localRect(node, this.shell), outer = node.getBoundingClientRect();
      const scaleX = outer.width / box.width, scaleY = outer.height / box.height;
      const position = (r: DOMRect) => ({ x: box.x + (r.x - outer.x) / scaleX, y: box.y + (r.y - outer.y) / scaleY, width: r.width / scaleX, height: r.height / scaleY });
      c.save(); c.beginPath(); c.rect(box.x, box.y, box.width, box.height); c.clip();
      c.fillStyle = '#fff'; c.strokeStyle = '#fff';
      // UI foreground remains fully readable while disabled; the original
      // disabled attribute still controls input and accessibility semantics.
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const value = text.textContent ?? ''; if (!value.trim()) continue;
        const parent = text.parentElement!, css = getComputedStyle(parent);
        const range = document.createRange(); range.selectNodeContents(text);
        const r = position(range.getBoundingClientRect());
        c.font = fontString(css); c.textBaseline = 'alphabetic'; c.textAlign = 'left';
        const metrics = c.measureText(value);
        // DOM Range line box uses the font ascent/descent, not ink bounds.
        const ascent = metrics.fontBoundingBoxAscent, descent = metrics.fontBoundingBoxDescent;
        const baseline = r.y + (r.height - ascent - descent) / 2 + ascent;
        if (parent.closest('time') || this.select) {
          // Canvas does not expose font-variant-numeric. Preserve React's
          // tabular digit positions instead of guessing their advances.
          for (let i = 0; i < value.length; i++) {
            const digit = document.createRange(); digit.setStart(text, i); digit.setEnd(text, i + 1);
            const rect = position(digit.getBoundingClientRect());
            c.fillText(value[i], rect.x, this.select ? rect.y + (rect.height - ascent - descent) / 2 + ascent : baseline);
          }
        } else c.fillText(value, r.x, baseline);
        this.result.textRuns++;
      }
      node.querySelectorAll<SVGSVGElement>('svg').forEach(svg => {
        const r = position(svg.getBoundingClientRect()), view = svg.viewBox.baseVal;
        c.save(); c.translate(r.x, r.y); c.scale(r.width / view.width, r.height / view.height); c.translate(-view.x, -view.y);
        svg.querySelectorAll<SVGGraphicsElement>('path,circle,rect,line,polyline,polygon,ellipse').forEach(shape => {
          const css = getComputedStyle(shape), path = new Path2D();
          const n = (key: string) => Number(shape.getAttribute(key) ?? 0);
          if (shape.tagName === 'path') path.addPath(new Path2D(shape.getAttribute('d') ?? ''));
          else if (shape.tagName === 'circle') path.arc(n('cx'), n('cy'), n('r'), 0, Math.PI * 2);
          else if (shape.tagName === 'ellipse') path.ellipse(n('cx'), n('cy'), n('rx'), n('ry'), 0, 0, Math.PI * 2);
          else if (shape.tagName === 'rect') path.roundRect(n('x'), n('y'), n('width'), n('height'), n('rx'));
          else if (shape.tagName === 'line') { path.moveTo(n('x1'), n('y1')); path.lineTo(n('x2'), n('y2')); }
          else { const points = (shape.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number); for (let i = 0; i < points.length; i += 2) { if (i) path.lineTo(points[i], points[i + 1]); else path.moveTo(points[i], points[i + 1]); } if (shape.tagName === 'polygon') path.closePath(); }
          c.lineWidth = parseFloat(css.strokeWidth); c.lineCap = css.strokeLinecap as CanvasLineCap; c.lineJoin = css.strokeLinejoin as CanvasLineJoin;
          if (css.fill !== 'none') c.fill(path); if (css.stroke !== 'none') c.stroke(path);
        });
        c.restore(); this.result.icons++;
      });
      node.querySelectorAll<HTMLElement>('.state-dot').forEach(dot => {
        const r = position(dot.getBoundingClientRect()); c.beginPath(); c.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, Math.PI * 2); c.fill(); this.result.dots++;
      });
      c.restore();
      const focus = node.matches(':focus-visible');
      if (node.matches('.learning-primary,.toolbar-feedback.is-ready') || (node.matches('button:hover:not(:disabled)') && !node.matches('.toolbar-grip,.toolbar-context')) || focus) {
        c.beginPath(); c.lineWidth = focus ? 1.5 : 1;
        c.roundRect(box.x + .75, box.y + .75, box.width - 1.5, box.height - 1.5, Math.min(14, box.height / 2)); c.stroke(); this.result.outlines++;
      }
      return { ...box, scaleX: 1, scaleY: 1, dx: 0, dy: 0 };
    });
    this.result.revision++;
  }
  dispose() {
    this.disposed = true; this.visible(false); this.observer.disconnect(); this.resize.disconnect();
    this.events.forEach(event => this.shell.removeEventListener(event, this.invalidate, true));
    document.fonts.removeEventListener('loadingdone', this.invalidate);
    this.canvas.width = this.canvas.height = 1; this.result.groups = [];
    for (const atlas of this.atlases.values()) { atlas.canvas.width = atlas.canvas.height = 1; atlas.result.groups = []; }
    this.atlases.clear();
  }
}
