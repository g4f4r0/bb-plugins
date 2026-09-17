import { z } from "zod";
import type { Cdp } from "./cdp";

const credentialField = z
  .object({
    selector: z.string().min(1).max(1000),
    label: z.string().min(1).max(100),
    kind: z.enum(["username", "password", "one-time-code"]),
  })
  .strict();
export const credentialRequest = z
  .object({
    id: z.string().min(1).max(200),
    purpose: z.string().min(1).max(300),
    fields: z.array(credentialField).min(1).max(6),
    submitSelector: z.string().min(1).max(1000),
  })
  .strict();
export const credentialValues = z
  .array(z.string().min(1).max(4096))
  .min(1)
  .max(6);
type CredentialRequest = z.infer<typeof credentialRequest>;

// These functions run in an isolated CDP world. Neither their captured node
// references nor the RPC arguments pass through the automation CLI or job log.
export const bindCredentialFormSource = String.raw`function(fields, submitSelector) {
  const url = new URL(location.href);
  if (url.username || url.password || !(url.protocol === "https:" ||
    (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))))
    throw Error("Secure website required");
  function deepQuery(root, selector) {
    let current = [root];
    const parts = String(selector).split(/\s*>>>\s*/);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      if (!part) throw Error("A unique field is required");
      const matches = current.flatMap(r => [...r.querySelectorAll(part)]);
      if (i === parts.length - 1) return matches;
      current = matches.map(e => e.shadowRoot).filter(Boolean);
    }
    return [];
  }
  function unique(selector) {
    const matches = [];
    const pierce = /\s*>>>\s*/.test(selector);
    function walk(root) {
      if (pierce) matches.push.apply(matches, deepQuery(root, selector));
      else {
        matches.push.apply(matches, root.querySelectorAll(selector));
        for (const e of root.querySelectorAll("*"))
          if (e.shadowRoot) walk(e.shadowRoot);
      }
    }
    walk(document);
    if (matches.length !== 1) throw Error("A unique field is required");
    return matches[0];
  }
  function visible(el) {
    const view = el.ownerDocument.defaultView;
    if (!view) return false;
    const box = el.getBoundingClientRect();
    const style = view.getComputedStyle(el);
    return el.isConnected && box.width > 0 && box.height > 0 &&
      style.visibility === "visible" && style.display !== "none" && Number(style.opacity) > 0;
  }
  function disabled(el) {
    return !!(el.disabled || el.getAttribute("aria-disabled") === "true");
  }
  function destination(el, fallback) {
    return new URL(el || fallback, el?.baseURI || document.baseURI);
  }
  function isContinue(el) {
    if (!visible(el) || disabled(el)) return false;
    if (el instanceof HTMLAnchorElement && el.hasAttribute("href") &&
      destination(el.href, url.href).origin !== url.origin) return false;
    if (el instanceof HTMLButtonElement) return el.type !== "reset";
    if (el instanceof HTMLInputElement) return el.type === "submit" || el.type === "button";
    return el.getAttribute("role") === "button";
  }
  const nodes = fields.map(f => unique(f.selector));
  if (new Set(nodes).size !== nodes.length) throw Error("Duplicate field");
  const button = unique(submitSelector);
  const href = location.href;
  function validate() {
    if (location.href !== href) throw Error("Page changed");
    nodes.forEach((node, i) => {
      if (unique(fields[i].selector) !== node || !(node instanceof HTMLInputElement) ||
        !visible(node) || disabled(node) || node.readOnly ||
        !["text", "email", "password", "tel", "number"].includes(node.type) ||
        (fields[i].kind === "password" && node.type !== "password")) throw Error("Field changed");
      const page = node.ownerDocument.location.href;
      if (node.form && (node.form.method !== "post" ||
        destination(node.form.action || page, page).origin !== url.origin))
        throw Error("Form destination changed");
    });
    if (unique(submitSelector) !== button || !isContinue(button)) throw Error("Continue button changed");
    if (button.formAction && destination(button.formAction, href).origin !== url.origin)
      throw Error("Submit destination changed");
    if (button.hasAttribute && button.hasAttribute("formmethod") && button.formMethod !== "post")
      throw Error("Unsafe form method");
    if (button.form && destination(button.form.action || href, href).origin !== url.origin)
      throw Error("Submit destination changed");
  }
  validate();
  return { nodes, button, validate, href, written: false };
}`;

export const fillCredentialFormSource = String.raw`function(values) {
  this.validate();
  if (values.length !== this.nodes.length) throw Error("Invalid field count");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  this.nodes.forEach((node, i) => {
    this.written = true;
    setter.call(node, values[i]);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
  this.validate();
  this.button.click();
  return true;
}`;

export const clearCredentialFormSource = String.raw`function() {
  if (!this.written) return true;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  for (const node of this.nodes) if (node.isConnected) setter.call(node, "");
  return true;
}`;

export class CredentialBinding {
  private constructor(
    private cdp: Cdp,
    private objectId: string,
    readonly origin: string,
  ) {}
  static async prepare(cdp: Cdp, input: CredentialRequest) {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const frames: { id: string }[] = [];
    (function walk(tree: {
      frame: { id: string };
      childFrames?: typeof tree[];
    }) {
      frames.push(tree.frame);
      for (const child of tree.childFrames ?? []) walk(child);
    })(frameTree);
    const expression = `(${bindCredentialFormSource})(${JSON.stringify(input.fields)},${JSON.stringify(input.submitSelector)})`;
    const found: { objectId: string; origin: string }[] = [];
    for (const frame of frames) {
      let objectId: string | undefined;
      try {
        const { executionContextId } = await cdp.send(
          "Page.createIsolatedWorld",
          { frameId: frame.id, worldName: "bb-credential-delivery" },
        );
        const result = await cdp.send("Runtime.evaluate", {
          expression,
          contextId: executionContextId,
          returnByValue: false,
        });
        if (result.exceptionDetails || !result.result?.objectId) continue;
        const boundId = result.result.objectId;
        objectId = boundId;
        const bound = await cdp.send("Runtime.callFunctionOn", {
          objectId: boundId,
          functionDeclaration:
            "function() { this.validate(); return new URL(this.href).origin; }",
          returnByValue: true,
        });
        if (bound.exceptionDetails || typeof bound.result?.value !== "string") {
          await cdp.send("Runtime.releaseObject", { objectId: boundId }).catch(() => {});
          continue;
        }
        found.push({ objectId: boundId, origin: bound.result.value });
      } catch {
        if (objectId)
          await cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
      }
    }
    if (found.length !== 1) {
      await Promise.all(
        found.map((item) =>
          cdp.send("Runtime.releaseObject", { objectId: item.objectId }).catch(
            () => {},
          ),
        ),
      );
      throw Error(
        "Login fields are unavailable or unsafe. Inspect the page and request again.",
      );
    }
    return new CredentialBinding(cdp, found[0].objectId, found[0].origin);
  }
  async fill(values: string[]) {
    const result = await this.cdp.send("Runtime.callFunctionOn", {
      objectId: this.objectId,
      functionDeclaration: fillCredentialFormSource,
      arguments: [{ value: values }],
      returnByValue: true,
    });
    if (result.exceptionDetails || result.result?.value !== true)
      throw Error("Credential delivery failed");
  }
  async dispose() {
    // Navigation destroys the original context. Otherwise erase filled inputs
    // before resuming automation, including after failed client-side validation.
    await this.cdp
      .send("Runtime.callFunctionOn", {
        objectId: this.objectId,
        functionDeclaration: clearCredentialFormSource,
        returnByValue: true,
      })
      .catch(() => {});
    await this.cdp
      .send("Runtime.releaseObject", { objectId: this.objectId })
      .catch(() => {});
  }
}
