import { useCallback, useEffect, useMemo, useState } from "react";
import { type AccessCatalog, useAccessCatalog } from "./access-catalog";
import {
  type AccessLine,
  describeLine,
  linesToScopes,
  narrowedNote,
  scopesToLines,
} from "./access-model";

/** Scopes a subject gets from elsewhere (a parent group, the user's groups): shown, not edited. */
export interface InheritedAccess {
  from: string;
  scopes: readonly string[];
}

/** One row of the access list. */
export interface AccessLineView {
  key: string;
  line: AccessLine;
  title: string;
  detail: string;
  /** The group the line comes from; such lines have no buttons. */
  from?: string;
  /** What a line wider than the token owner's access really does. */
  note?: string;
  /** Index in the own lines, for Edit and Remove. */
  index?: number;
}

export interface AccessEditor {
  catalog: AccessCatalog;
  /** The own lines, once the catalog is ready. */
  lines: AccessLine[];
  /** The own lines' scopes: what saving stores. */
  scopes: string[];
  /** The scopes differ from the ones the dialog opened with. */
  changed: boolean;
  views: AccessLineView[];
  /** Adds a line, or replaces the line at `index`. */
  saveLine: (line: AccessLine, index?: number) => void;
  removeLine: (index: number) => void;
  /** Rebuilds the lines from raw scopes (the scope picker). */
  replaceScopes: (scopes: readonly string[]) => void;
  /** The scopes of every line but the one at `index`. */
  scopesWithout: (index: number | undefined) => string[];
}

interface AccessEditorOptions {
  open: boolean;
  /** The subject's own stored scopes when the dialog opened. */
  scopes: readonly string[];
  inherited?: readonly InheritedAccess[];
  /** A token's owner: lines wider than these scopes get a note on what they really do. */
  ownerScopes?: readonly string[];
}

/**
 * The state of an access list: own lines parsed from the stored scopes once the folders and
 * names they need are loaded, edited as lines, and saved as the scopes they build.
 */
const NO_INHERITED: readonly InheritedAccess[] = [];

export function useAccessEditor({
  open,
  scopes: initialScopes,
  inherited = NO_INHERITED,
  ownerScopes,
}: AccessEditorOptions): AccessEditor {
  const catalog = useAccessCatalog(open, [
    ...initialScopes,
    ...inherited.flatMap((item) => item.scopes),
  ]);
  const { ctx, labels, ready } = catalog;
  const [lines, setLines] = useState<AccessLine[] | null>(null);
  const initialKey = [...new Set(initialScopes)].sort().join("\n");

  // Parse the stored scopes once per opening, when the folders they name are known.
  useEffect(() => {
    if (!open) {
      setLines(null);
      return;
    }
    if (!ready) return;
    setLines((current) => current ?? scopesToLines(initialKey ? initialKey.split("\n") : [], ctx));
  }, [open, ready, ctx, initialKey]);

  const ownLines = useMemo(() => lines ?? [], [lines]);
  const scopes = useMemo(
    () => (lines ? linesToScopes(lines, ctx) : initialKey ? initialKey.split("\n") : []),
    [ctx, initialKey, lines]
  );
  const changed = scopes.join("\n") !== initialKey;

  const views = useMemo<AccessLineView[]>(() => {
    const own = ownLines.map((line, index) => ({
      key: `own-${index}`,
      line,
      index,
      ...describeLine(line, labels),
      note: ownerScopes ? (narrowedNote(line, ownerScopes, ctx, labels) ?? undefined) : undefined,
    }));
    const fromElsewhere = inherited.flatMap((item, itemIndex) =>
      (ready ? scopesToLines(item.scopes, ctx) : []).map((line, index) => ({
        key: `from-${itemIndex}-${index}`,
        line,
        from: item.from,
        ...describeLine(line, labels),
      }))
    );
    return [...own, ...fromElsewhere];
  }, [ctx, inherited, labels, ownLines, ownerScopes, ready]);

  const saveLine = useCallback((line: AccessLine, index?: number) => {
    setLines((current) => {
      const next = [...(current ?? [])];
      if (index === undefined) next.push(line);
      else next[index] = line;
      return next;
    });
  }, []);

  const removeLine = useCallback((index: number) => {
    setLines((current) => (current ?? []).filter((_, lineIndex) => lineIndex !== index));
  }, []);

  const replaceScopes = useCallback(
    (next: readonly string[]) => setLines(scopesToLines(next, ctx)),
    [ctx]
  );

  const scopesWithout = useCallback(
    (index: number | undefined) =>
      linesToScopes(
        ownLines.filter((_, lineIndex) => lineIndex !== index),
        ctx
      ),
    [ctx, ownLines]
  );

  return {
    catalog,
    lines: ownLines,
    scopes,
    changed,
    views,
    saveLine,
    removeLine,
    replaceScopes,
    scopesWithout,
  };
}
