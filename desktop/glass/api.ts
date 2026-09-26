import type { Configuration, Geometry, Monitor, Telemetry } from './contract';
import type { MaterialSettings } from './material-settings';
import type { MotionSettings } from './motion';
export type AppearanceKind = 'material' | 'motion';
export type SavedState = { source: string; savedAt: string | null; dirty: boolean; warning: string | null };
export type AppearanceState = Configuration & { revision: number; failure: string | null; saved: Record<AppearanceKind, SavedState> };
export type AppearancePatch = { mode?: Configuration['mode']; fps?: 30 | 60; startupEnabled?: boolean; menuFrost?: boolean; enabled?: boolean; reduced?: boolean; motion?: Partial<MotionSettings> };
export type PreviewAction = 'preview-grip' | 'preview-center' | 'preview-turn' | 'preview-release';
export interface AppearanceApi {
  config(): Promise<AppearanceState>;
  onConfig(callback: (value: AppearanceState) => void): () => void;
  monitors(): Promise<Monitor[]>;
  prepareCapture(monitorId: string): Promise<void>;
  configure(value: AppearancePatch): Promise<AppearanceState>;
  tune(patch: Partial<MaterialSettings>): Promise<AppearanceState>;
  saveMaterial(): Promise<{ path: string }>;
  saveMotion(): Promise<{ path: string }>;
  importSettings(kind: AppearanceKind): Promise<void>;
  geometry(): Promise<Geometry>;
  onGeometry(callback: (value: Geometry) => void): () => void;
  pointer(inside?: boolean): void;
  placement(value: { x: number; y: number; dragging: boolean }): void;
  report(value: Telemetry): void;
  telemetry(): Promise<Telemetry | null>;
  onTelemetry(callback: (value: Telemetry) => void): () => void;
  utility(action: PreviewAction): Promise<void>;
  onDiagnostic(callback: (value: string) => void): () => void;
  contextMenu(): void;
  consumeFeedback(sessionId: number, roundId: number): Promise<boolean>;
}
declare global { interface Window { appearance: AppearanceApi } }
