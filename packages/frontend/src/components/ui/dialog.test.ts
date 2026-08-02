/// <reference types="node" />

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { assertNoNestedDialogVerticalScroll } from "./dialog";

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
