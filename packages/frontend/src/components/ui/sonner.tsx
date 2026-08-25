"use client";

import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ToasterProps } from "sonner";
import { Toaster as SonnerToaster } from "sonner";

/** Shadcn-style Sonner: dark gray toasts like tooltips. Close button to dismiss. */
function Toaster(props: ToasterProps) {
  const toaster = (
    <SonnerToaster
      theme="dark"
      closeButton
      {...props}
      style={{ ...props.style, "--z-index": "1000" } as CSSProperties}
    />
  );
  return typeof document === "undefined" ? toaster : createPortal(toaster, document.body);
}

export { Toaster };
