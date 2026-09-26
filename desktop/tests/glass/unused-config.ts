// The browser-only GPU fixture always uses simulated:true. Production config
// parsing belongs in Node and is covered by t16-config/t16-analysis tests.
// Throw rather than silently simulate credentials if that boundary is crossed.
export function readConfiguration(): never { throw new Error('GPU fixture must not read analysis configuration'); }
export function readAsrConfiguration(): never { throw new Error('GPU fixture must not read ASR configuration'); }
