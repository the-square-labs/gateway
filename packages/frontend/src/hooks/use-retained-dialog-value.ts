import { useEffect, useState } from "react";

export function useRetainedDialogValue<T>(value: T, open: boolean): T {
  const [retainedValue, setRetainedValue] = useState(value);

  useEffect(() => {
    if (open) setRetainedValue(value);
  }, [open, value]);

  return open ? value : retainedValue;
}
