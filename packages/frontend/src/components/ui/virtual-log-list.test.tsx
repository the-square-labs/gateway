import { fireEvent, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { VirtualLogList } from "./virtual-log-list";

let renderedCount = 0;
let scrollToIndex = vi.fn();

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    getItemKey,
  }: {
    count: number;
    getItemKey: (index: number) => string | number;
  }) => {
    renderedCount = count;
    return {
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({
          index,
          key: getItemKey(index),
          start: index * 10,
        })),
      getTotalSize: () => count * 10,
      measureElement: vi.fn(),
      scrollToIndex,
    };
  },
}));

beforeEach(() => {
  renderedCount = 0;
  scrollToIndex = vi.fn();
});

it("opens a populated log viewport at the newest line", () => {
  render(
    <VirtualLogList
      lines={["first", "second", "latest"]}
      keyFn={(_, index) => index}
      renderLine={(line) => <div>{line}</div>}
      initialScrollToEnd
    />
  );

  expect(scrollToIndex).toHaveBeenCalledWith(2, { align: "end" });
});

it("follows appended lines only while the user remains at the bottom", () => {
  const lines = Array.from({ length: 100 }, (_, index) => `line-${index}`);
  const { container, rerender } = render(
    <VirtualLogList
      lines={lines}
      keyFn={(_, index) => index}
      renderLine={(line) => <div>{line}</div>}
    />
  );
  const scroller = container.firstElementChild as HTMLDivElement;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 100 });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: () => renderedCount * 10,
  });

  scroller.scrollTop = 900;
  fireEvent.scroll(scroller);
  rerender(
    <VirtualLogList
      lines={[...lines, "live-append"]}
      keyFn={(_, index) => index}
      renderLine={(line) => <div>{line}</div>}
    />
  );
  expect(scrollToIndex).toHaveBeenCalledWith(100, { align: "end" });

  scrollToIndex.mockClear();
  scroller.scrollTop = 400;
  fireEvent.scroll(scroller);
  rerender(
    <VirtualLogList
      lines={[...lines, "live-append", "another-append"]}
      keyFn={(_, index) => index}
      renderLine={(line) => <div>{line}</div>}
    />
  );
  expect(scrollToIndex).not.toHaveBeenCalled();
});

it("keeps the same visible log line when older history is prepended", () => {
  const onLoadMore = vi.fn();
  const lines = Array.from({ length: 200 }, (_, index) => `line-${index}`);
  const prependedLines = [
    ...Array.from({ length: 200 }, (_, index) => `older-${index}`),
    ...lines,
    "live-append",
  ];

  const { container, rerender } = render(
    <VirtualLogList
      lines={lines}
      keyFn={(_, index) => index}
      renderLine={(line) => <div>{line}</div>}
      onLoadMore={onLoadMore}
      hasMore
    />
  );

  const scroller = container.firstElementChild as HTMLDivElement;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 100 });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: () => renderedCount * 10,
  });
  scroller.scrollTop = 20;

  fireEvent.scroll(scroller);
  expect(onLoadMore).toHaveBeenCalledTimes(1);

  rerender(
    <VirtualLogList
      lines={[...lines, "live-append"]}
      keyFn={(_, index) => index}
      renderLine={(line) => <div>{line}</div>}
      onLoadMore={onLoadMore}
      hasMore
      loadingMore
    />
  );

  rerender(
    <VirtualLogList
      lines={prependedLines}
      keyFn={(_, index) => index}
      renderLine={(line) => <div>{line}</div>}
      onLoadMore={onLoadMore}
      hasMore
      prependVersion={1}
    />
  );

  expect(scroller.scrollTop).toBe(2020);
});
