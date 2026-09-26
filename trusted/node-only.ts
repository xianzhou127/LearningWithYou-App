// Deliberate Node builtin boundary: browser bundlers cannot resolve this module.
// Electron renderer builds also reject trusted imports.
import { versions } from "node:process";
if (!versions.node || typeof window !== "undefined") throw new Error("Trusted Node environment required");
