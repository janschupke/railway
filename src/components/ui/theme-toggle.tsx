"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { ToggleGroup } from "radix-ui";
import { cn } from "@/lib/utils";

type ThemeChoice = "light" | "dark" | "system";

const OPTIONS: Array<{ value: ThemeChoice; label: string; Icon: typeof Sun }> = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

const STORAGE_KEY = "theme";

/*
 * localStorage is an external store, so it is read with useSyncExternalStore rather
 * than mirrored into state by an effect. That keeps the component free of the
 * read-then-setState pattern and makes the value correct on the very first client
 * render instead of one render late.
 *
 * `listeners` covers same-tab writes; the `storage` event only fires in *other* tabs.
 */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function getSnapshot(): ThemeChoice {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/** The server cannot see localStorage, so it renders the neutral choice. */
function getServerSnapshot(): ThemeChoice {
  return "system";
}

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") {
    delete root.dataset.theme;
    window.localStorage.removeItem(STORAGE_KEY);
  } else {
    root.dataset.theme = choice;
    window.localStorage.setItem(STORAGE_KEY, choice);
  }
  for (const listener of listeners) listener();
}

/**
 * Theme switch. "System" removes the override so the OS preference applies again,
 * rather than freezing whatever the OS happened to be at the time.
 */
export function ThemeToggle() {
  const choice = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <ToggleGroup.Root
      type="single"
      value={choice}
      aria-label="Colour theme"
      onValueChange={(next) => {
        if (next) apply(next as ThemeChoice);
      }}
      className="border-border flex rounded-md border p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <ToggleGroup.Item
          key={value}
          value={value}
          aria-label={label}
          className={cn(
            "focus-ring text-text-subtle rounded p-1.5 transition-colors",
            "hover:text-text data-[state=on]:bg-subtle data-[state=on]:text-text",
          )}
        >
          <Icon aria-hidden className="size-3.5" />
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
