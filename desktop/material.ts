export type SurfaceMaterial = "acrylic" | "solid";
// DWM's public system backdrop API starts at Windows 11 22H2 (build 22621).
export function surfaceMaterial(platform: string, release: string, reduceTransparency: boolean, forcedColors: boolean): SurfaceMaterial {
  const [major, , build] = release.split(".").map(Number);
  return platform === "win32" && major >= 10 && build >= 22621 && !reduceTransparency && !forcedColors ? "acrylic" : "solid";
}
