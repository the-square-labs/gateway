import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "dialog-overlay fixed inset-0 z-50 bg-black/50 overflow-hidden flex items-end sm:items-start justify-center sm:overflow-y-auto sm:py-12",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-dialog-header=""
    className={cn("flex flex-col space-y-1.5 text-left", className)}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-2 sm:gap-0",
      className
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DIALOG_OUTER_OVERFLOW_CLASS_RE =
  /(?:^|\s)(?:[^\s:]+:)*overflow(?:-[xy])?-(?:auto|scroll|hidden|visible|clip)(?=\s|$)/g;
const DIALOG_NESTED_VERTICAL_SCROLL_CLASS_RE =
  /(?:^|\s)(?:[^\s:]+:)*overflow-y-(?:auto|scroll)(?=\s|$)/;

function stripOuterOverflowClasses(className?: string) {
  return className?.replace(DIALOG_OUTER_OVERFLOW_CLASS_RE, " ").replace(/\s+/g, " ").trim();
}

function isDialogSlot(child: React.ReactNode, displayName: string) {
  if (!React.isValidElement(child)) return false;
  const type = child.type as { displayName?: string };
  return type.displayName === displayName;
}

export function assertNoNestedDialogVerticalScroll(children: React.ReactNode[]) {
  for (const child of children) {
    if (!React.isValidElement<{ className?: unknown }>(child)) continue;
    const className = child.props.className;
    if (typeof className === "string" && DIALOG_NESTED_VERTICAL_SCROLL_CLASS_RE.test(className)) {
      throw new Error(
        "DialogContent owns vertical scrolling. Remove overflow-y-auto/scroll from its body child."
      );
    }
  }
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    hideCloseButton?: boolean;
    unstyled?: boolean;
    clipOverflow?: boolean;
  }
>(({ className, children, hideCloseButton, unstyled, clipOverflow, ...props }, ref) => {
  const [bodyScrolled, setBodyScrolled] = React.useState(false);
  const contentClassName = stripOuterOverflowClasses(className);
  const childArray = React.Children.toArray(children);
  const headerChildren: React.ReactNode[] = [];
  const footerChildren: React.ReactNode[] = [];
  const bodyChildren: React.ReactNode[] = [];

  for (const child of childArray) {
    if (isDialogSlot(child, "DialogHeader")) {
      headerChildren.push(child);
    } else if (isDialogSlot(child, "DialogFooter")) {
      footerChildren.push(child);
    } else {
      bodyChildren.push(child);
    }
  }

  const hasHeader = headerChildren.length > 0;
  const hasFooter = footerChildren.length > 0;

  assertNoNestedDialogVerticalScroll(bodyChildren);

  if (unstyled) {
    return (
      <DialogPortal>
        <DialogOverlay>
          <DialogPrimitive.Content
            ref={ref}
            className={cn(
              "dialog-content relative z-50 grid w-full gap-4 border bg-background p-6 shadow-lg outline-none",
              "max-h-[85dvh] max-w-none overflow-y-auto",
              "sm:mx-auto sm:my-auto sm:max-h-none sm:overflow-visible sm:max-w-lg",
              className
            )}
            {...props}
          >
            {children}
            {!hideCloseButton && (
              <DialogPrimitive.Close className="absolute right-4 top-4 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </DialogPrimitive.Close>
            )}
          </DialogPrimitive.Content>
        </DialogOverlay>
      </DialogPortal>
    );
  }

  return (
    <DialogPortal>
      <DialogOverlay>
        <DialogPrimitive.Content
          ref={ref}
          className={cn(
            "dialog-content relative z-50 flex w-full max-w-none flex-col border bg-background p-0 shadow-lg outline-none",
            "max-h-[85dvh]",
            "sm:mx-auto sm:my-auto sm:max-h-none sm:max-w-lg",
            contentClassName,
            clipOverflow && "sm:overflow-clip",
            "max-sm:flex max-sm:max-h-[85dvh] max-sm:flex-col max-sm:gap-0 max-sm:overflow-hidden max-sm:p-0"
          )}
          {...props}
        >
          {hasHeader ? (
            <div
              data-dialog-header-slot=""
              className={cn(
                "flex shrink-0 items-start justify-between gap-4 px-4 pb-4 pt-4 transition-shadow duration-200 ease-out sm:px-6 sm:pt-6",
                bodyScrolled ? "max-sm:shadow-[inset_0_-1px_0_var(--color-border)]" : ""
              )}
            >
              <div className="min-w-0 flex-1">{headerChildren}</div>
              {!hideCloseButton && (
                <DialogPrimitive.Close className="shrink-0 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close</span>
                </DialogPrimitive.Close>
              )}
            </div>
          ) : null}
          {bodyChildren.length > 0 ? (
            <div
              data-dialog-body=""
              className={cn(
                "min-h-0 min-w-0 px-4 max-sm:flex-1 max-sm:overflow-y-auto max-sm:overscroll-contain sm:px-6",
                bodyChildren.length > 1 && "grid gap-4",
                hasHeader ? "pt-0" : "pt-4 sm:pt-6",
                hasFooter ? "pb-0" : "pb-4 sm:pb-6"
              )}
              onScroll={(event) => setBodyScrolled(event.currentTarget.scrollTop > 0)}
            >
              {bodyChildren}
            </div>
          ) : null}
          {hasFooter ? (
            <div className="shrink-0 px-4 pb-4 pt-4 sm:px-6 sm:pb-6">{footerChildren}</div>
          ) : null}
          {!hideCloseButton && !hasHeader && (
            <DialogPrimitive.Close className="absolute right-4 top-4 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogOverlay>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    data-dialog-title=""
    className={cn("text-lg font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    data-dialog-description=""
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
