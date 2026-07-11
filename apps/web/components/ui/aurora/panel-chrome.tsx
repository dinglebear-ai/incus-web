/**
 * Aurora panel grammar (Homelab Hub source design).
 *
 * Cards: vertical panel gradient over a soft color-mix edge, 8px radius,
 * medium shadow with an inset top highlight. Consoles: near-black surface
 * for streaming logs. Status is always a glowing dot + colored label.
 */

import type { CSSProperties } from "react";

export const PANEL =
  "rounded-[8px] border border-[var(--soft-edge)] bg-[linear-gradient(180deg,var(--aurora-panel-strong-top),var(--aurora-panel-strong))] shadow-[var(--aurora-shadow-medium),var(--aurora-highlight-medium)]";

export const SUBPANEL =
  "rounded-[6px] border border-[var(--soft-edge)] bg-[var(--aurora-control-surface)]";

export const CONSOLE =
  "rounded-[6px] border border-[var(--soft-edge)] bg-[#040c12] shadow-[var(--aurora-shadow-medium),inset_0_1px_0_rgba(255,255,255,0.03)]";

/** Header strip for a PANEL: icon + title row over a slightly darkened band. */
export const PANEL_HEADER =
  "flex items-center gap-2.5 border-b border-[var(--soft-edge)] bg-[color-mix(in_srgb,var(--aurora-page-bg)_35%,transparent)] px-4 py-3";

export function GlowDot({
  color,
  size = 8,
  style,
}: {
  color: string;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: color,
        boxShadow: `0 0 7px ${color}`,
        ...style,
      }}
    />
  );
}

export function logLevelColor(level: string) {
  if (level === "error") return "var(--aurora-error)";
  if (level === "warn" || level === "warning") return "var(--aurora-warn)";
  return "var(--aurora-text-muted)";
}
