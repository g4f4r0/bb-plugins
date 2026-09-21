// Browser-safe constants shared by the live-frame handler and the UI.

/** Fixed, exact-match plugin HTTP route for the private live view. */
export const liveHttpRoutes = { frame: "/v1/live/frame" } as const;

export const LIVE_FRAME_HEADERS = {
  sequence: "x-wayfinder-frame-sequence",
  state: "x-wayfinder-frame-state",
  ageMs: "x-wayfinder-frame-age-ms",
  width: "x-wayfinder-frame-width",
  height: "x-wayfinder-frame-height",
} as const;
