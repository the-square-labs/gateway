import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_CLOSE_DELAY_MS = 250;

export function useDeferredDialogState<T>(closeDelayMs = DEFAULT_CLOSE_DELAY_MS) {
  const [open, setOpen] = useState(false);
  const [value, setStoredValue] = useState<T | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const close = useCallback(
    (afterClose?: () => void) => {
      clearCloseTimer();
      setOpen(false);
      closeTimerRef.current = setTimeout(() => {
        setStoredValue(null);
        closeTimerRef.current = null;
        afterClose?.();
      }, closeDelayMs);
    },
    [clearCloseTimer, closeDelayMs]
  );

  const setValue = useCallback(
    (nextValue: T | null) => {
      if (nextValue === null) {
        close();
        return;
      }
      clearCloseTimer();
      setStoredValue(nextValue);
      setOpen(true);
    },
    [clearCloseTimer, close]
  );

  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        clearCloseTimer();
        setOpen(true);
        return;
      }
      close();
    },
    [clearCloseTimer, close]
  );

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  return { open, value, setValue, close, onOpenChange };
}
