"use client";

import type { CSSProperties } from "react";
import type { ToasterProps } from "sonner";
import { Toaster as SonnerToaster } from "sonner";

/** Shadcn-style Sonner: dark gray toasts like tooltips. Close button to dismiss. */
function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      theme="dark"
      closeButton
      {...props}
      style={{ ...props.style, "--z-index": "100" } as CSSProperties}
    />
  );
}

export { Toaster };
