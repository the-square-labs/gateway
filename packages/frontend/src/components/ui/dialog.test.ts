/// <reference types="node" />

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { assertNoNestedDialogVerticalScroll, DialogFooter } from "./dialog";

function collectTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : collectTsxFiles(fullPath);
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [fullPath] : [];
  });
}

function jsxElementName(element: ts.JsxElement) {
  return ts.isIdentifier(element.openingElement.tagName) ? element.openingElement.tagName.text : "";
}

function isNamedJsxElement(node: ts.JsxChild, name: string) {
  return ts.isJsxElement(node) && jsxElementName(node) === name;
}

function hasHeaderDescription(node: ts.JsxElement) {
  let found = false;
  const visit = (current: ts.Node) => {
    if (ts.isJsxElement(current) && jsxElementName(current) === "DialogDescription") {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function isRenderableBodyChild(child: ts.JsxChild): boolean {
  if (ts.isJsxText(child)) return child.getText().trim().length > 0;
  if (ts.isJsxExpression(child)) return child.expression !== undefined;
  if (ts.isJsxFragment(child)) return child.children.some(isRenderableBodyChild);
  return true;
}

function findHeaderDescriptionWithoutBody(sourceRoot: string) {
  const violations: string[] = [];
  for (const file of collectTsxFiles(sourceRoot)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) && jsxElementName(node) === "DialogContent") {
        const children = node.children.filter(
          (child) => !ts.isJsxText(child) || child.getText(source).trim() !== ""
        );
        const header = children.find((child) => isNamedJsxElement(child, "DialogHeader"));
        const body = children.filter(
          (child) =>
            !isNamedJsxElement(child, "DialogHeader") && !isNamedJsxElement(child, "DialogFooter")
        );
        if (
          header &&
          ts.isJsxElement(header) &&
          hasHeaderDescription(header) &&
          !body.some(isRenderableBodyChild)
        ) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          violations.push(`${relative(sourceRoot, file)}:${position.line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

const SPLIT_FOOTER_CLASS_RE =
  /(?:^|\s)(?:[^\s:]+:)*(?:justify-(?:between|around|evenly|start)|mr-auto|ml-auto)(?=\s|$)/;
const FOOTER_SPACER_CLASS_RE = /^\s*(?:flex-1|grow)\s*$/;

function classNameTexts(element: ts.JsxOpeningLikeElement) {
  const texts: string[] = [];
  for (const attribute of element.attributes.properties) {
    if (!ts.isJsxAttribute(attribute) || !attribute.initializer) continue;
    if (!ts.isIdentifier(attribute.name) || attribute.name.text !== "className") continue;
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) texts.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(attribute.initializer);
  }
  return texts;
}

/** Dialog footers that push some of their buttons to the left edge. */
function findSplitDialogFooters(sourceRoot: string) {
  const violations: string[] = [];
  for (const file of collectTsxFiles(sourceRoot)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const report = (node: ts.Node) => {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${relative(sourceRoot, file)}:${position.line + 1}`);
    };
    const visitFooter = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const texts = classNameTexts(node);
        if (
          texts.some((text) => SPLIT_FOOTER_CLASS_RE.test(text)) ||
          (ts.isJsxSelfClosingElement(node) &&
            texts.some((text) => FOOTER_SPACER_CLASS_RE.test(text)))
        ) {
          report(node);
        }
      }
      ts.forEachChild(node, visitFooter);
    };
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) && jsxElementName(node) === "DialogFooter") {
        visitFooter(node);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

describe("DialogFooter layout", () => {
  it("drops a split alignment passed by a call site", () => {
    const markup = renderToStaticMarkup(
      createElement(DialogFooter, { className: "shrink-0 justify-between sm:justify-between" })
    );
    expect(markup).toContain("sm:justify-end");
    expect(markup).toContain("shrink-0");
    expect(markup).not.toContain("justify-between");
  });

  it("keeps every dialog footer's buttons together on the right", () => {
    const sourceRoot = existsSync(join(process.cwd(), "src"))
      ? join(process.cwd(), "src")
      : join(process.cwd(), "packages/frontend/src");
    expect(findSplitDialogFooters(sourceRoot)).toEqual([]);
  });
});

describe("DialogContent layout guard", () => {
  it("rejects a nested vertical scroll container", () => {
    expect(() =>
      assertNoNestedDialogVerticalScroll([
        createElement("div", { className: "max-h-[70vh] overflow-y-auto" }),
      ])
    ).toThrow("DialogContent owns vertical scrolling");
  });

  it("allows non-scrolling body wrappers", () => {
    expect(() =>
      assertNoNestedDialogVerticalScroll([createElement("div", { className: "space-y-4" })])
    ).not.toThrow();
  });

  it("does not allow a header subtitle without a separate dialog body anywhere in the frontend", () => {
    const sourceRoot = existsSync(join(process.cwd(), "src"))
      ? join(process.cwd(), "src")
      : join(process.cwd(), "packages/frontend/src");
    expect(findHeaderDescriptionWithoutBody(sourceRoot)).toEqual([]);
  });
});
