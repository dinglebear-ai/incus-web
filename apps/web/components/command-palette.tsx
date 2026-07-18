"use client";

import { SearchIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import * as React from "react";

export type CommandPaletteItem = {
  id: string;
  title: string;
  sub: string;
  kind: string;
  icon: LucideIcon;
  accent: string;
  run: () => void;
};

export function CommandPalette({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: CommandPaletteItem[];
}) {
  // Mounting fresh on every open resets query/highlight without effects.
  if (!open) return null;
  return <PaletteDialog onClose={onClose} items={items} />;
}

function PaletteDialog({
  onClose,
  items,
}: {
  onClose: () => void;
  items: CommandPaletteItem[];
}) {
  const [query, setQuery] = React.useState("");
  const [highlight, setHighlight] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(needle) ||
        item.sub.toLowerCase().includes(needle),
    );
  }, [items, query]);

  const activeIndex = Math.min(highlight, Math.max(filtered.length - 1, 0));

  function runItem(item: CommandPaletteItem) {
    onClose();
    item.run();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight(Math.min(activeIndex + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight(Math.max(activeIndex - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = filtered[activeIndex];
      if (item) runItem(item);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(4,10,16,0.62)] pt-[13vh]"
      onClick={onClose}
      onKeyDown={onKeyDown}
    >
      <div
        className="w-[600px] max-w-[92vw] overflow-hidden rounded-[8px] border border-[var(--aurora-border-strong)] bg-[linear-gradient(180deg,var(--aurora-panel-strong-top),var(--aurora-panel-strong))] shadow-[var(--aurora-shadow-strong),var(--aurora-highlight-strong)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--soft-edge)] px-[18px] py-[15px]">
          <SearchIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-[var(--aurora-accent-primary)]"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            placeholder="Search workspaces, tools, and actions…"
            aria-label="Search workspaces, tools, and actions"
            className="min-w-0 flex-1 border-none bg-transparent text-[15px] text-[var(--aurora-text-primary)] outline-none placeholder:text-[var(--aurora-text-muted)]"
          />
          <kbd className="rounded-[3px] border border-[var(--soft-edge)] bg-[var(--aurora-nav-bg)] px-1.5 py-0.5 text-[10.5px] text-[var(--aurora-text-muted)]">
            esc
          </kbd>
        </div>

        <div className="max-h-[52vh] overflow-y-auto p-2">
          {filtered.map((item, index) => {
            const active = index === activeIndex;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => runItem(item)}
                onMouseEnter={() => setHighlight(index)}
                className="flex w-full items-center gap-3 rounded-[6px] px-2.5 py-2 text-left transition-colors"
                style={{
                  background: active
                    ? "color-mix(in srgb, var(--aurora-accent-primary) 12%, transparent)"
                    : undefined,
                }}
              >
                <span
                  className="flex size-[30px] shrink-0 items-center justify-center rounded-[5px]"
                  style={{
                    color: item.accent,
                    background: `color-mix(in srgb, ${item.accent} 13%, var(--aurora-control-surface))`,
                  }}
                >
                  <Icon aria-hidden="true" className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-[var(--aurora-text-primary)]">
                    {item.title}
                  </span>
                  <span className="block truncate text-[11px] text-[var(--aurora-text-muted)]">
                    {item.sub}
                  </span>
                </span>
                <span className="shrink-0 rounded-[3px] border border-[var(--soft-edge)] px-[7px] py-0.5 text-[10px] uppercase tracking-[0.08em] text-[var(--aurora-text-muted)]">
                  {item.kind}
                </span>
              </button>
            );
          })}
          {filtered.length === 0 ? (
            <div className="p-6 text-center text-[13px] text-[var(--aurora-text-muted)]">
              No matches.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
