import { vi } from "vitest";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
installTestPluginRuntime();
if (typeof document !== "undefined")
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
vi.stubGlobal(
  "IntersectionObserver",
  class {
    constructor(private callback: (entries: unknown[]) => void) {}
    observe() {
      this.callback([{ isIntersecting: true }]);
    }
    unobserve() {}
    disconnect() {}
  },
);
if (typeof Range !== "undefined")
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (typeof Range !== "undefined")
  Range.prototype.getBoundingClientRect = () => new DOMRect();
if (typeof HTMLElement !== "undefined")
  HTMLElement.prototype.scrollTo = function (
    options: ScrollToOptions | number,
  ) {
    this.scrollTop = typeof options === "number" ? options : (options.top ?? 0);
    this.dispatchEvent(new Event("scroll"));
  };
