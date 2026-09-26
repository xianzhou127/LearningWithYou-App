import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { MoreMenu } from '../learning-surfaces';
import type { Presentation, Snapshot } from '../shared';
import type { Configuration } from './contract';
import { MenuMaterial } from './menu-material';
import './menu.css';

export function LiquidMenu({ state, presentation, config, error, attach, wake }: {
  state: Snapshot; presentation: Presentation; config: Configuration | null; error: string | null;
  attach: (value: MenuMaterial | null) => void; wake: () => void;
}) {
  const shell = useRef<HTMLDivElement>(null), material = useRef<MenuMaterial | null>(null);
  useEffect(() => {
    if (!presentation.menuOpen) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void window.desktop.view('collapse'); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [presentation.menuOpen]);
  useLayoutEffect(() => {
    const menu = new MenuMaterial(shell.current!, { bounds: { x: 0, y: 0, width: 252, height: 280 }, scale: 1, direction: 'down' }, wake);
    material.current = menu; attach(menu);
    return () => { attach(null); material.current = null; menu.dispose(); };
  }, [attach, wake]);
  useLayoutEffect(() => { if (config) material.current?.configure(config); }, [config]);
  useLayoutEffect(() => { material.current?.setOpen(presentation.menuOpen); }, [presentation.menuOpen]);
  const height = useCallback((value: number) => { material.current?.height(value); window.desktop.menuHeight(value); }, []);
  // Keep layout measurable for startup prewarming. Closed menu is invisible,
  // inert and stops drawing, while its bounded renderer cache remains reusable.
  return <div ref={shell} className="liquid-menu" style={{ width: 252 }} data-open={presentation.menuOpen} data-reading={config?.mode === 'C' && !!config.material.adaptiveText} inert={!presentation.menuOpen}>
    <MoreMenu state={state} open={presentation.menuOpen} direction={presentation.menu?.direction} error={error || state.error}
      onHeight={height} onView={view => { void window.desktop.view(view); }}
      onAction={type => { void window.desktop.act({ type, revision: state.revision }).catch(() => window.desktop.view('operation-failed')); }} />
  </div>;
}
