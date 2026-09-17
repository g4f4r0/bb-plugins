import { it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { viewerHtml } from "../src/viewer";

function extract(name: string): string {
  const line = viewerHtml
    .split("\n")
    .find((entry) => entry.startsWith(`function ${name}(){`));
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
     <button id="rotate-viewport"></button><span id="resolution"></span>`,
    { runScripts: "outside-only", pretendToBeVisual: true },
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
    const status={textContent:''};
    function fit(){}
    function setResponsiveTransport(){}
    const responsiveLoadingIcon='<svg data-icon="loading"/>',responsivePhoneIcon='<svg data-icon="phone"/>';
    ${extract("responsiveNeedsControl")}
    ${extract("noteResponsiveQueued")}
    ${extract("renderResponsive")}
    ${extract("cancelResponsive")}
    ${extract("onControlQueueCleared")}
    window.test={
      render:renderResponsive, note:noteResponsiveQueued,
      cleared:onControlQueueCleared,
      toggle:()=>document.querySelector('#responsive-toggle'),
      controls:()=>document.querySelector('#responsive-controls'),
      widthInput:()=>document.querySelector('#responsive-width'),
      status,
      pending:()=>responsivePending,
      set(state){
        if('responsiveAvailable' in state)responsiveAvailable=state.responsiveAvailable;
        if('responsivePending' in state)responsivePending=state.responsivePending;
        if('responsiveCommitSent' in state)responsiveCommitSent=state.responsiveCommitSent;
        if('hasControl' in state)hasControl=state.hasControl;
        if('takingControl' in state)takingControl=state.takingControl;
      },
    };
  `);
  return { dom, test: (window as unknown as { test: TestApi }).test };
}

type TestApi = {
  render: () => void;
  note: () => void;
  cleared: () => void;
  toggle: () => HTMLButtonElement;
  controls: () => HTMLElement;
  widthInput: () => HTMLInputElement;
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
