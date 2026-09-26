import { BaseWindow, ImageView, nativeImage, screen, type BrowserWindow } from "electron";

import { SHADOW_MARGIN, shadowBitmap } from "./shadow-bitmap";

// ImageView needs no renderer process. The owned window is transparent,
// non-activating and always click-through, including its centre. Capture protection
// follows the owner's policy: mandatory for material hosts, configurable otherwise.
export function attachSurfaceShadow(owner: BrowserWindow, radius: number, contentProtection: boolean) {
  const shadow = new BaseWindow({ title: "T14.5 surface shadow", parent: owner, show: false, frame: false, thickFrame: false,
    transparent: true, backgroundColor: "#00000000", roundedCorners: false, hasShadow: false,
    resizable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, width: 1, height: 1 });
  shadow.setContentProtection(contentProtection);
  shadow.setIgnoreMouseEvents(true);
  shadow.setAlwaysOnTop(true, "screen-saver");
  const view = new ImageView(); view.setBackgroundColor("#00000000"); shadow.setContentView(view);
  let key = "", opacity = owner.getOpacity();
  const sync = () => {
    if (owner.isDestroyed() || shadow.isDestroyed()) return;
    const b = owner.getBounds(), scale = screen.getDisplayMatching(b).scaleFactor;
    const curve = radius * owner.webContents.getZoomFactor();
    const nextKey = `${b.width}:${b.height}:${curve}:${scale}`;
    const bounds = { x: b.x - SHADOW_MARGIN, y: b.y - SHADOW_MARGIN, width: b.width + SHADOW_MARGIN * 2, height: b.height + SHADOW_MARGIN * 2 };
    const current = shadow.getBounds();
    if (Object.entries(bounds).some(([key, value]) => current[key as keyof typeof current] !== value)) shadow.setBounds(bounds, false);
    if (key !== nextKey) {
      const bitmap = shadowBitmap(b.width, b.height, curve, scale);
      view.setImage(nativeImage.createFromBitmap(bitmap.pixels, { width: bitmap.width, height: bitmap.height, scaleFactor: scale }));
      key = nextKey;
    }
    if (owner.isVisible() && !shadow.isVisible()) { shadow.setOpacity(opacity); shadow.showInactive(); }
  };
  const hide = () => { if (!shadow.isDestroyed()) shadow.hide(); };
  owner.on("move", sync); owner.on("resize", sync); owner.on("show", sync); owner.on("hide", hide);
  owner.once("closed", () => { if (!shadow.isDestroyed()) shadow.destroy(); });
  sync();
  return { sync, setOpacity(value: number) { opacity = value; if (!shadow.isDestroyed()) shadow.setOpacity(value); } };
}
