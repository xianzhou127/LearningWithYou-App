import type { ReactNode } from "react";

const paths = {
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  grip: <g fill="currentColor" stroke="none"><circle cx="8" cy="5" r="1.6" /><circle cx="16" cy="5" r="1.6" /><circle cx="8" cy="12" r="1.6" /><circle cx="16" cy="12" r="1.6" /><circle cx="8" cy="19" r="1.6" /><circle cx="16" cy="19" r="1.6" /></g>,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
  feedback: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-6 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2 5h10M7 13h6" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
  book: <path d="M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1Zm0 0v15" />,
  play: <path d="m8 5 11 7-11 7Z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  minimize: <path d="M5 16h14" />,
  maximize: <rect x="5" y="5" width="14" height="14" rx=".5" />,
  "restore-window": <><path d="M9 5V3h12v12h-2" /><rect x="3" y="9" width="12" height="12" rx=".5" /></>,
  history: <path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2" />,
  alert: <><path d="m12 3 10 18H2Z" /><path d="M12 9v5m0 3v1" /></>,
  working: <path d="M12 3a9 9 0 1 1-9 9M3 4v5h5" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;
export function UiIcon({ name }: { name: IconName }) {
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
