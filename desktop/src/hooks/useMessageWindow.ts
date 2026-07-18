/**
 * Virtual window over a chat transcript (#148).
 * Keeps streaming/last rows mounted; preserves stick-to-bottom via full totalHeight.
 */
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  DEFAULT_OVERSCAN,
  DEFAULT_ROW_ESTIMATE_PX,
  computeWindowPlan,
  forceKeepIndices,
} from "../components/shell/messageWindow";

export function useMessageWindow<T extends { id: string; streaming?: boolean }>(
  messages: T[],
  scrollRef: RefObject<HTMLDivElement | null>,
) {
  const heightsById = useRef<Map<string, number>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [clientHeight, setClientHeight] = useState(600);
  const [heightRev, setHeightRev] = useState(0);

  const syncMetrics = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setClientHeight(el.clientHeight || 600);
  }, [scrollRef]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    syncMetrics();
    const onScroll = () => syncMetrics();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => syncMetrics())
        : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
    };
  }, [scrollRef, syncMetrics, messages.length]);

  const onHeightChange = useCallback((id: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) return;
    const prev = heightsById.current.get(id);
    if (prev != null && Math.abs(prev - height) < 1) return;
    heightsById.current.set(id, height);
    setHeightRev((n) => n + 1);
  }, []);

  const heightList = useMemo(() => {
    void heightRev;
    return messages.map(
      (m) => heightsById.current.get(m.id) ?? DEFAULT_ROW_ESTIMATE_PX,
    );
  }, [messages, heightRev]);

  const force = useMemo(() => forceKeepIndices(messages), [messages]);

  const plan = useMemo(
    () =>
      computeWindowPlan({
        count: messages.length,
        scrollTop,
        clientHeight,
        heights: heightList,
        estimatePx: DEFAULT_ROW_ESTIMATE_PX,
        overscan: DEFAULT_OVERSCAN,
        forceIndices: force,
      }),
    [messages.length, scrollTop, clientHeight, heightList, force],
  );

  const mounted = useMemo(
    () =>
      plan.indices.map((i) => ({
        index: i,
        msg: messages[i]!,
        top: plan.offsets[i] ?? 0,
      })),
    [plan, messages],
  );

  return {
    virtualized: plan.virtualized,
    totalHeight: plan.totalHeight,
    onHeightChange,
    mounted,
  };
}
