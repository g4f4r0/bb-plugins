import { it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { viewerHtml } from "../src/viewer";

function extract(name: string): string {
  const line = viewerHtml
    .split("\n")
    .find((entry) => entry.startsWith(`function ${name}(`));
  if (!line) throw new Error(`missing ${name} in viewerHtml`);
  return line;
}

function harness() {
  const dom = new JSDOM(
    `<button id="responsive-toggle" aria-pressed="false"></button>
     <div id="responsive-controls" hidden></div>
     <main id="viewport"></main>
      <select id="device-preset"><option value="responsive">Responsive</option><option value="custom" hidden>Custom</option></select>
     <input id="responsive-width"><input id="responsive-height">
     <button id="rotate-viewport"></button><span id="resolution"></span>
     <div id="devtools-divider" hidden></div>
     <div id="devtools-wrap" hidden><div id="devtools-header"><span>DevTools</span></div><div id="devtools-status"></div><iframe id="devtools-frame"></iframe></div>`,
    {
      runScripts: "outside-only",
      pretendToBeVisual: true,
      url: "https://bb.test/api/v1/plugins/browse/http/viewer?id=test&bbTheme=light",
    },
  );
  const { window } = dom;
  window.eval(`
    const responsiveToggle=document.querySelector('#responsive-toggle'),
      responsiveControls=document.querySelector('#responsive-controls'),
      viewport=document.querySelector('#viewport'),
      devicePreset=document.querySelector('#device-preset'),
      responsiveWidthInput=document.querySelector('#responsive-width'),
      responsiveHeightInput=document.querySelector('#responsive-height');
    let responsiveEnabled=false,responsiveWidth=412,responsiveHeight=915,
      responsiveMobile=true,responsivePreset='responsive',
      responsiveAvailable=true,responsivePending=null,
      responsiveCommitSent=false,expectedFrameWidth=0,expectedFrameHeight=0,
      vw=1280,vh=800,hasControl=false,takingControl=false;
    let devtoolsPaneOpen=false,devtoolsToken='',devtoolsRev='',devtoolsThemeWritten=null,
      devtoolsWidth=520,devtoolsTokenReady=false;
    const status={textContent:''};
    function fit(){}
    function setResponsiveTransport(){}
    const responsiveLoadingIcon='<svg data-icon="loading"/>',responsivePhoneIcon='<svg data-icon="phone"/>';
    ${extract("responsiveNeedsControl")}
    ${extract("noteResponsiveQueued")}
    ${extract("renderResponsive")}
    ${extract("cancelResponsive")}
    ${extract("onControlQueueCleared")}
    ${extract("devtoolsWantTheme")}
    ${extract("seedDevtoolsTheme")}
    ${extract("renderDevtools")}
    ${extract("devtoolsFrameUrl")}
    window.test={
      render:renderResponsive, note:noteResponsiveQueued,
      cleared:onControlQueueCleared,
      wantTheme:devtoolsWantTheme, seedTheme:seedDevtoolsTheme,
      renderPane:renderDevtools, frameUrl:devtoolsFrameUrl,
      toggle:()=>document.querySelector('#responsive-toggle'),
      controls:()=>document.querySelector('#responsive-controls'),
      widthInput:()=>document.querySelector('#responsive-width'),
      pane:()=>document.querySelector('#devtools-wrap'),
      divider:()=>document.querySelector('#devtools-divider'),
      storedTheme:()=>window.localStorage.getItem('ui-theme'),
      status,
      pending:()=>responsivePending,
      set(state){
        if('responsiveAvailable' in state)responsiveAvailable=state.responsiveAvailable;
        if('responsivePending' in state)responsivePending=state.responsivePending;
        if('responsiveCommitSent' in state)responsiveCommitSent=state.responsiveCommitSent;
        if('hasControl' in state)hasControl=state.hasControl;
        if('takingControl' in state)takingControl=state.takingControl;
        if('devtoolsPaneOpen' in state)devtoolsPaneOpen=state.devtoolsPaneOpen;
        if('devtoolsWidth' in state)devtoolsWidth=state.devtoolsWidth;
        if('devtoolsThemeWritten' in state)devtoolsThemeWritten=state.devtoolsThemeWritten;
      },
    };
  `);
  return { dom, test: (window as unknown as { test: TestApi }).test };
}

type TestApi = {
  render: () => void;
  note: () => void;
  cleared: () => void;
  wantTheme: () => string;
  seedTheme: (mode: string) => boolean;
  renderPane: () => void;
  frameUrl: (token: string, rev: string) => string;
  toggle: () => HTMLButtonElement;
  controls: () => HTMLElement;
  widthInput: () => HTMLInputElement;
  pane: () => HTMLElement;
  divider: () => HTMLElement;
  storedTheme: () => string | null;
  status: { textContent: string };
  pending: () => unknown;
  set: (state: Record<string, unknown>) => void;
};

it("shows a loading icon and disables the toggle while staging", () => {
  const { dom, test } = harness();
  try {
    test.render();
    expect(test.toggle().disabled).toBe(false);
    expect(test.toggle().hasAttribute("data-pending")).toBe(false);
    expect(test.toggle().innerHTML).toContain('data-icon="phone"');
    test.set({ takingControl: true });
    test.render();
    // Taking control alone must not disable the toggle.
    expect(test.toggle().disabled).toBe(false);
    expect(test.toggle().hasAttribute("data-pending")).toBe(false);
    test.set({
      takingControl: false,
      responsivePending: {
        enabled: true,
        width: 390,
        height: 844,
        mobile: true,
        preset: "custom",
      },
    });
    test.render();
    expect(test.toggle().disabled).toBe(true);
    expect(test.toggle().getAttribute("data-pending")).toBe("true");
    expect(test.toggle().innerHTML).toContain('data-icon="loading"');
    expect(test.toggle().getAttribute("aria-label")).toBe(
      "Switching viewport…",
    );
    test.set({ responsiveAvailable: false, responsivePending: null });
    test.render();
    expect(test.toggle().disabled).toBe(true);
    expect(test.toggle().innerHTML).toContain('data-icon="phone"');
    expect(test.toggle().getAttribute("aria-label")).toBe("Responsive mode");
  } finally {
    dom.window.close();
  }
});

it("narrates the queued first tap instead of staying silent", () => {
  const { dom, test } = harness();
  try {
    test.set({ hasControl: false, responsivePending: null });
    test.note();
    expect(test.status.textContent).toBe("Taking control…");
    test.set({ hasControl: false, responsivePending: { enabled: true } });
    test.note();
    expect(test.status.textContent).toBe("Working…");
  } finally {
    dom.window.close();
  }
});

it("flips the panel and dims instantly from the staged target", () => {
  const { dom, test } = harness();
  try {
    test.set({
      responsivePending: {
        enabled: true,
        width: 390,
        height: 844,
        mobile: true,
        preset: "custom",
      },
    });
    test.render();
    expect(test.toggle().getAttribute("aria-pressed")).toBe("true");
    expect(test.controls().hidden).toBe(false);
    expect(test.widthInput().value).toBe("390");
  } finally {
    dom.window.close();
  }
});

it("rolls back an uncommitted stage when control is lost", () => {
  const { dom, test } = harness();
  try {
    test.set({
      responsivePending: {
        enabled: true,
        width: 390,
        height: 844,
        mobile: true,
        preset: "custom",
      },
      responsiveCommitSent: false,
    });
    test.cleared();
    expect(test.pending()).toBeNull();
    test.render();
    expect(test.toggle().getAttribute("aria-pressed")).toBe("false");
    expect(test.controls().hidden).toBe(true);
  } finally {
    dom.window.close();
  }
});

it("keeps a committed stage when control drops mid-flight", () => {
  const { dom, test } = harness();
  try {
    const staged = {
      enabled: true,
      width: 390,
      height: 844,
      mobile: true,
      preset: "custom",
    };
    test.set({ responsivePending: staged, responsiveCommitSent: true });
    test.cleared();
    expect(test.pending()).toBe(staged);
  } finally {
    dom.window.close();
  }
});

it("reads the BB theme from the viewer url", () => {
  const { dom, test } = harness();
  try {
    expect(test.wantTheme()).toBe("light");
  } finally {
    dom.window.close();
  }
});

it("seeds the frontend theme without clobbering user overrides", () => {
  const { dom, test } = harness();
  try {
    expect(test.seedTheme("dark")).toBe(true);
    expect(test.storedTheme()).toBe('"dark"');
    // Same mode again is a no-op.
    expect(test.seedTheme("dark")).toBe(false);
    // A user override inside DevTools survives reopen under the same mode.
    dom.window.localStorage.setItem("ui-theme", '"default"');
    expect(test.seedTheme("dark")).toBe(false);
    expect(test.storedTheme()).toBe('"default"');
    // An already-matching value needs no reload.
    expect(test.seedTheme("light")).toBe(false);
    // A BB theme change wins over a stale foreign value.
    dom.window.localStorage.setItem("ui-theme", '"systemPreferred"');
    test.set({ devtoolsThemeWritten: '"dark"' });
    expect(test.seedTheme("light")).toBe(true);
    expect(test.storedTheme()).toBe('"default"');
  } finally {
    dom.window.close();
  }
});

it("shows and sizes the DevTools pane", () => {
  const { dom, test } = harness();
  try {
    test.set({ devtoolsPaneOpen: false });
    test.renderPane();
    expect(test.pane().hidden).toBe(true);
    expect(test.divider().hidden).toBe(true);
    test.set({ devtoolsPaneOpen: true, devtoolsWidth: 480 });
    test.renderPane();
    expect(test.pane().hidden).toBe(false);
    expect(test.divider().hidden).toBe(false);
    expect(test.pane().style.width).toBe("480px");
  } finally {
    dom.window.close();
  }
});

it("builds a same-origin frontend url with an encoded debugger target", () => {
  const { dom, test } = harness();
  try {
    const url = test.frameUrl("abc123", "151.0.7910-deadbeef");
    expect(url).toContain("./devtools/151.0.7910-deadbeef/abc123/inspector.html?ws=");
    expect(url).toContain(encodeURIComponent("devtools-ws?token=abc123"));
  } finally {
    dom.window.close();
  }
});

it("keeps the page pane stretched across the viewer grid", () => {
  // Regression: without stretch, #page-pane collapses to content size under
  // main's place-items:center, and fit() then shrinks the surface into it.
  expect(viewerHtml).toContain(
    "#page-pane{position:relative;display:grid;place-items:center;flex:1;min-width:0;min-height:0;overflow:hidden;padding:12px;align-self:stretch;justify-self:stretch}",
  );
});
