import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ButtonHTMLAttributes } from "react";

/**
 * Icon-only control with an accessible name and a native tooltip. Disabled
 * controls keep their explanation in the tooltip and `aria-description`.
 */
export function IconButton({
  icon,
  label,
  tooltip,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconSvgElement; label: string; tooltip?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={tooltip ?? label}
      className={`inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      {...props}
    >
      <HugeiconsIcon icon={icon} size={16} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}
