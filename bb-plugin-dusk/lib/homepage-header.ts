const leftSelector = '[data-testid="app-desktop-sidebar-trigger"] [data-sidebar="trigger"], [data-testid="app-sidebar-trigger-overlay"] [data-sidebar="trigger"]';
const showSelector = 'button[aria-label^="Show right panel"]:not([data-dusk-panel-toggle])';
const hideSelector = 'button[aria-label^="Hide right panel"]:not([data-dusk-panel-toggle])';

/** Keep homepage controls stable while BB swaps and slides its native headers. */
export function mountHomepageHeader(host: HTMLElement, control: HTMLElement, cutout: HTMLElement) {
  // The SDK has no general panel toggle. Keep the native actions as the source
  // of state and behavior, with one persistent, viewport-pinned presentation.
  const panel = document.createElement("button");
  panel.type = "button";
  panel.dataset.duskPanelToggle = "";
  panel.className = "dusk-panel-toggle";
  panel.hidden = true;
  document.body.append(panel);
  let disposed = false, scheduled = 0, motionFrame = 0;
  let artwork: Element | null = null;
  const transitions = new Map<Element, Set<string>>();
  const setAttribute = (name: string, value: string) => { if (panel.getAttribute(name) !== value) panel.setAttribute(name, value); };
  const click = () => (document.querySelector<HTMLButtonElement>(showSelector) ?? document.querySelector<HTMLButtonElement>(hideSelector))?.click();
  panel.addEventListener("click", click);

  function mobileShelfActive() {
    if (!window.matchMedia("(max-width: 767px)").matches) return false;
    const inset = host.closest("[data-sidebar='inset']");
    return inset?.hasAttribute("data-vaul-animate") || inset?.getAttribute("data-sidebar-shelf") === "open";
  }

  const style = (element: HTMLElement, name: string, value: string) => {
    if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
  };
  function position() {
    if (disposed) return;
    const trigger = document.querySelector<HTMLElement>(leftSelector);
    const rect = trigger?.getBoundingClientRect(), bounds = host.getBoundingClientRect();
    // Desktop follows the left toggle through sidebar width. Mobile hides the
    // pencil instead, so keep the resting x rather than sliding it with the shelf.
    const x = mobileShelfActive()
      ? Number.parseFloat(control.style.getPropertyValue("--dusk-header-x")) || 12
      : (rect ? Math.max(12, rect.right + 4 - bounds.left) : 12);
    const y = rect ? Math.max(0, rect.top - bounds.top) : 10;
    for (const element of [control, cutout]) {
      style(element, "--dusk-header-y", `${y}px`);
      style(element, "--dusk-header-x", `${x}px`);
    }
    const strip = host.querySelector('[data-testid="root-compose-main-window-drag-strip"]');
    if (strip && cutout.parentElement !== strip) strip.append(cutout);
    if (!strip) cutout.remove();
    style(panel, "transform", `translateY(${rect?.top ?? 10}px)`);
    if (rect) {
      style(panel, "width", `${rect.width}px`);
      style(panel, "height", `${rect.height}px`);
    }
  }

  function sync() {
    scheduled = 0;
    if (disposed) return;
    const show = document.querySelector<HTMLButtonElement>(showSelector);
    const native = show ?? document.querySelector<HTMLButtonElement>(hideSelector);
    const left = document.querySelector<HTMLElement>(leftSelector);
    position();
    panel.hidden = !native;
    if (native) {
      // Use the left trigger's complete responsive sizing and hover treatment.
      const className = `${left?.className ?? native.className} dusk-panel-toggle`;
      if (panel.className !== className) panel.className = className;
      const icon = native.querySelector('[data-icon="PanelRight"]');
      if (icon && icon !== artwork) { panel.replaceChildren(icon.cloneNode(true)); artwork = icon; }
      setAttribute("aria-label", native.getAttribute("aria-label") ?? "Toggle right panel");
      setAttribute("title", native.getAttribute("aria-label") ?? "Toggle right panel");
      setAttribute("aria-expanded", String(!show));
      panel.disabled = native.disabled;
    }
  }
  const schedule = () => { if (!disposed && !scheduled) scheduled = requestAnimationFrame(sync); };
  const relevant = `${leftSelector}, ${showSelector}, ${hideSelector}, [data-testid="root-compose-main-window-drag-strip"]`;
  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === "attributes"
      ? record.target instanceof Element && record.target.matches(relevant)
      : [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(node => node instanceof Element && (node.matches(relevant) || node.querySelector(relevant))))) schedule();
  });
  observer.observe(document.querySelector('[data-testid="app-layout-root"]') ?? document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["aria-expanded", "aria-label", "disabled"],
  });
  const resize = new ResizeObserver(schedule); resize.observe(host);
  window.addEventListener("resize", schedule);

  function followMotion() {
    motionFrame = 0;
    position();
    if (!disposed && transitions.size) motionFrame = requestAnimationFrame(followMotion);
  }
  function transition(event: TransitionEvent) {
    const target = event.target;
    if (!(target instanceof Element) || !target.contains(host)) return;
    if (window.matchMedia("(max-width: 767px)").matches && (event.propertyName === "translate" || event.propertyName === "transform")) return;
    if (!["translate", "transform", "width", "flex-basis", "flex-grow"].includes(event.propertyName)) return;
    if (event.type === "transitionrun") {
      const properties = transitions.get(target) ?? new Set<string>();
      properties.add(event.propertyName); transitions.set(target, properties);
      if (!motionFrame) motionFrame = requestAnimationFrame(followMotion);
    } else {
      const properties = transitions.get(target); properties?.delete(event.propertyName);
      if (!properties?.size) transitions.delete(target);
      schedule();
    }
  }
  document.addEventListener("transitionrun", transition);
  document.addEventListener("transitionend", transition);
  document.addEventListener("transitioncancel", transition);
  sync();
  return () => {
    disposed = true; observer.disconnect(); resize.disconnect();
    cancelAnimationFrame(scheduled); cancelAnimationFrame(motionFrame);
    window.removeEventListener("resize", schedule);
    document.removeEventListener("transitionrun", transition);
    document.removeEventListener("transitionend", transition);
    document.removeEventListener("transitioncancel", transition);
    panel.removeEventListener("click", click); panel.remove(); cutout.remove();
  };
}
