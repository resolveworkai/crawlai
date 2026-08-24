/** Authored by: Mohit Singh */
//
// Light/dark theme toggle — client-only persisted state (localStorage key "theme"), synced across
// every consumer (app-shell.tsx's ThemeToggle button, __root.tsx's <Toaster theme=...>) via
// useSyncExternalStore rather than React Context: the only two consumers sit at unrelated points
// in the tree, and a full Context provider would be overkill for one string value. The <html>
// element's own "dark" class is the single source of truth on the DOM side — this hook reads/
// writes it directly rather than duplicating state that could drift out of sync with it.
//
// The actual FLASH-OF-WRONG-THEME prevention lives in __root.tsx's blocking inline <script> (runs
// before paint, before this hook's code ever loads) — this hook's job is just keeping React state
// in sync with whatever that script (or a later toggle click) already set on the DOM.
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "theme";

function getSnapshot(): Theme {
  if (typeof document === "undefined") return "dark"; // SSR — matches __root.tsx's server render
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function getServerSnapshot(): Theme {
  return "dark";
}

const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // localStorage can throw in a locked-down/private-browsing context — the theme still applies
    // for this page load, it just won't persist across reloads.
  }
  for (const listener of listeners) listener();
}

export function useTheme(): {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
} {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    theme,
    toggleTheme: () => applyTheme(theme === "dark" ? "light" : "dark"),
    setTheme: applyTheme,
  };
}
