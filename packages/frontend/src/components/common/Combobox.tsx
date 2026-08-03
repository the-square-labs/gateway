import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface ComboboxOption {
  value: string;
  label: string;
  keywords?: string;
  disabled?: boolean;
}

interface ComboboxProps {
  value: string;
  options: ComboboxOption[];
  onValueChange: (value: string) => void;
  freeText?: boolean;
  showAllOptionsOnFocus?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  contentClassName?: string;
  ariaLabel?: string;
  renderOption?: (option: ComboboxOption) => ReactNode;
}

export function Combobox({
  value,
  options,
  onValueChange,
  freeText = false,
  showAllOptionsOnFocus = false,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  emptyMessage = "No results found.",
  disabled,
  className,
  inputClassName,
  contentClassName,
  ariaLabel,
  renderOption,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showAllOptions, setShowAllOptions] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value]
  );
  const filteredOptions = useMemo(() => {
    if (showAllOptions) return options;
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return options;
    return options.filter((option) =>
      [option.label, option.keywords, option.value]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    );
  }, [options, query, showAllOptions]);

  useEffect(() => {
    setActiveIndex(filteredOptions.length > 0 ? 0 : -1);
  }, [filteredOptions]);

  const close = () => {
    setOpen(false);
  };

  const finishClose = () => {
    setQuery("");
    setActiveIndex(-1);
    setShowAllOptions(false);
  };

  const selectOption = (option: ComboboxOption) => {
    if (option.disabled) return;
    onValueChange(option.value);
    close();
  };

  const contentOpen = open && !disabled && (!freeText || filteredOptions.length > 0);

  return (
    <Popover
      open={contentOpen}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setOpen(true);
        else close();
      }}
    >
      <div
        ref={rootRef}
        className={cn("relative w-full", className)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) close();
        }}
      >
        <PopoverAnchor asChild>
          <Input
            role="combobox"
            aria-label={ariaLabel}
            aria-expanded={contentOpen}
            value={open ? query : freeText ? value : (selected?.label ?? "")}
            onFocus={() => {
              setQuery(freeText ? value : "");
              setShowAllOptions(showAllOptionsOnFocus);
              setOpen(true);
            }}
            onChange={(event) => {
              const nextValue = event.target.value;
              setQuery(nextValue);
              setShowAllOptions(false);
              setOpen(true);
              if (freeText) onValueChange(nextValue);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                close();
                event.currentTarget.blur();
                return;
              }
              if (!open || filteredOptions.length === 0) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) => (index + 1) % filteredOptions.length);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => (index <= 0 ? filteredOptions.length - 1 : index - 1));
              } else if (event.key === "Enter" && activeIndex >= 0) {
                event.preventDefault();
                selectOption(filteredOptions[activeIndex]!);
              }
            }}
            placeholder={open ? searchPlaceholder : placeholder}
            className={cn("pr-10", inputClassName)}
            disabled={disabled}
          />
        </PopoverAnchor>
        <ChevronDown className="pointer-events-none absolute right-3 top-[18px] h-4 w-4 -translate-y-1/2 opacity-50" />
        <PopoverContent
          align="start"
          sideOffset={4}
          collisionPadding={16}
          onAnimationEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              event.currentTarget.dataset.state === "closed"
            ) {
              finishClose();
            }
          }}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (event.target instanceof Node && rootRef.current?.contains(event.target)) {
              event.preventDefault();
            }
          }}
          style={{ pointerEvents: "auto" }}
          className={cn(
            "dropdown-content z-50 max-h-[min(16rem,var(--radix-popover-content-available-height))] w-max min-w-[var(--radix-popover-trigger-width)] max-w-[var(--radix-popover-content-available-width)] overflow-y-auto overscroll-contain p-1",
            contentClassName
          )}
        >
          {filteredOptions.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">{emptyMessage}</div>
          ) : (
            filteredOptions.map((option, index) => (
              <button
                type="button"
                key={option.value}
                ref={
                  index === activeIndex
                    ? (element) => element?.scrollIntoView({ block: "nearest" })
                    : undefined
                }
                aria-disabled={option.disabled}
                className={cn(
                  "relative flex w-full items-center gap-2 whitespace-nowrap px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground aria-disabled:opacity-50",
                  index === activeIndex && "bg-accent text-accent-foreground"
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectOption(option);
                }}
              >
                {renderOption?.(option) ?? option.label}
              </button>
            ))
          )}
        </PopoverContent>
      </div>
    </Popover>
  );
}
