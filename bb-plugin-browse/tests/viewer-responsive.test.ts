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
     <select id="device-preset"><option value="responsive">Responsive</option></select>
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
      vw=1280,vh=800,hasControl=false,takingControl=false;
    const status={textContent:''};
    function fit(){}
    ${extract("responsiveNeedsControl")}
    ${extract("noteResponsiveQueued")}
    ${extract("renderResponsive")}
    window.test={
      render:renderResponsive, note:noteResponsiveQueued,
      toggle:()=>document.querySelector('#responsive-toggle'),
      status,
      set(state){
        if('responsiveAvailable' in state)responsiveAvailable=state.responsiveAvailable;
        if('responsivePending' in state)responsivePending=state.responsivePending;
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
  toggle: () => HTMLButtonElement;
  status: { textContent: string };
  set: (state: Record<string, unknown>) => void;
};

it("keeps the toggle enabled while taking control or waiting for a frame", () => {
  const { dom, test } = harness();
  try {
    test.render();
    expect(test.toggle().disabled).toBe(false);
    expect(test.toggle().hasAttribute("data-pending")).toBe(false);
    test.set({ takingControl: true });
    test.render();
    // First tap must not disable itself mid-takeover.
    expect(test.toggle().disabled).toBe(false);
    expect(test.toggle().getAttribute("data-pending")).toBe("true");
    test.set({
      takingControl: false,
      responsivePending: { enabled: true },
    });
    test.render();
    expect(test.toggle().disabled).toBe(false);
    expect(test.toggle().getAttribute("data-pending")).toBe("true");
    test.set({ responsiveAvailable: false, responsivePending: null });
    test.render();
    expect(test.toggle().disabled).toBe(true);
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
