import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

const NARROW_SIDEBAR_QUERY = "(max-width: 760px)";

function startsNarrow(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(NARROW_SIDEBAR_QUERY).matches
  );
}

/**
 * Keep the desktop sidebar preference while treating narrow navigation as a
 * transient drawer. Entering the narrow breakpoint always starts on the safe
 * 48px rail; users can still open the drawer explicitly to switch chats.
 */
export function useResponsiveSidebar(
  wideCollapsed: boolean,
  setWideCollapsed: Dispatch<SetStateAction<boolean>>,
) {
  const [narrow, setNarrow] = useState(startsNarrow);
  const [narrowOpen, setNarrowOpen] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NARROW_SIDEBAR_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      setNarrow(event.matches);
      setNarrowOpen(false);
    };

    setNarrow(query.matches);
    setNarrowOpen(false);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const toggle = useCallback(() => {
    if (narrow) {
      setNarrowOpen((open) => !open);
      return;
    }
    setWideCollapsed((collapsed) => !collapsed);
  }, [narrow, setWideCollapsed]);

  const dismissNarrow = useCallback(() => {
    if (narrow) setNarrowOpen(false);
  }, [narrow]);

  return {
    collapsed: narrow ? !narrowOpen : wideCollapsed,
    dismissNarrow,
    narrow,
    toggle,
  };
}
