/**
 * State for the shared Activity Inspector surface: the display mode, which
 * turn is selected, dock width, and a responsive fallback so a wide-only
 * Docked rail degrades to Drawer on narrow viewports.
 *
 * One preference, many surfaces. Ordinary chat and the Log Explorer both call
 * this hook, and a change made in either is persisted once and broadcast to
 * the other through `subscribeActivityMode` — so "one shared persisted display
 * preference" is true even with both open at the same time.
 *
 * Deliberately UI-agnostic: this hook only tracks state, never renders.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_DOCK_WIDTH,
  clampDockWidth,
  loadActivityMode,
  loadDockWidth,
  saveActivityMode,
  saveDockWidth,
  subscribeActivityMode,
} from "../lib/activity/prefs";
import type { ActivityMode } from "../lib/activity/types";

/** Below this viewport width, a "docked" preference renders as a Drawer instead. */
export const NARROW_VIEWPORT_PX = 880;

function readViewportWidth(): number {
  if (typeof window === "undefined") return Number.POSITIVE_INFINITY;
  return window.innerWidth || Number.POSITIVE_INFINITY;
}

export type ActivitySurface = "none" | "drawer" | "docked";

export function useActivityInspector() {
  const [mode, setModeState] = useState<ActivityMode>(() => loadActivityMode());
  const [dockWidth, setDockWidthState] = useState<number>(() => loadDockWidth());
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    readViewportWidth(),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setViewportWidth(readViewportWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Another surface changed the shared preference: adopt it without writing
  // it back (which would loop) and without stealing the user's selection.
  useEffect(
    () =>
      subscribeActivityMode((next) => {
        setModeState(next);
        if (next === "off" || next === "compact") setDrawerOpen(false);
      }),
    [],
  );

  const setMode = useCallback((next: ActivityMode) => {
    setModeState(next);
    saveActivityMode(next);
    if (next === "off" || next === "compact") {
      setDrawerOpen(false);
    }
  }, []);

  const setDockWidth = useCallback((px: number) => {
    const clamped = clampDockWidth(px);
    setDockWidthState(clamped);
    saveDockWidth(clamped);
  }, []);

  const selectTurn = useCallback((turnId: string | null) => {
    setSelectedTurnId(turnId);
  }, []);

  /** "Details" action: always opens an overlay, regardless of persisted mode. */
  const openDrawerFor = useCallback((turnId: string) => {
    setSelectedTurnId(turnId);
    setDrawerOpen(true);
  }, []);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const isNarrowViewport = viewportWidth < NARROW_VIEWPORT_PX;

  /**
   * What should actually render right now.
   *
   * `off` is absolute: no surface, at any width, for any selection. Docked
   * degrades to Drawer under NARROW_VIEWPORT_PX so the rail never
   * permanently reflows a narrow window.
   */
  const surface: ActivitySurface = useMemo(() => {
    if (mode === "off") return "none";
    if (mode === "docked") {
      if (!selectedTurnId) return "none";
      return isNarrowViewport ? "drawer" : "docked";
    }
    // "drawer" | "compact": overlay-based, so it only appears on an explicit
    // Details click (openDrawerFor), never automatically.
    return drawerOpen && selectedTurnId ? "drawer" : "none";
  }, [mode, isNarrowViewport, selectedTurnId, drawerOpen]);

  return {
    mode,
    setMode,
    dockWidth: dockWidth || DEFAULT_DOCK_WIDTH,
    setDockWidth,
    selectedTurnId,
    selectTurn,
    drawerOpen,
    openDrawerFor,
    closeDrawer,
    isNarrowViewport,
    surface,
  };
}

export type UseActivityInspector = ReturnType<typeof useActivityInspector>;
