import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

const NARROW_SIDEBAR_MAX_WIDTH = 760;

function startsNarrow(): boolean {
  return (
    typeof window !== "undefined" &&
    window.innerWidth <= NARROW_SIDEBAR_MAX_WIDTH
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
    const onResize = () => {
      setNarrow(window.innerWidth <= NARROW_SIDEBAR_MAX_WIDTH);
      setNarrowOpen(false);
    };

    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
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
