import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function listTsxFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTsxFiles(target);
    return entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
      ? [target]
      : [];
  });
}

function jsxTagName(tag: ts.JsxTagNameExpression, sourceFile: ts.SourceFile): string {
  return ts.isIdentifier(tag) ? tag.text : tag.getText(sourceFile);
}

describe("Dialog payload retention", () => {
  it("does not clear payload used by a closing Dialog without the retained-value pattern", () => {
    const sourceRoot = path.resolve(process.cwd(), "src");
    const findings: string[] = [];

    for (const file of listTsxFiles(sourceRoot)) {
      const source = fs.readFileSync(file, "utf8");
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );

      const visit = (node: ts.Node) => {
        if (
          ts.isJsxElement(node) &&
          jsxTagName(node.openingElement.tagName, sourceFile) === "Dialog"
        ) {
          const onOpenChange = node.openingElement.attributes.properties.find(
            (attribute): attribute is ts.JsxAttribute =>
              ts.isJsxAttribute(attribute) &&
              ts.isIdentifier(attribute.name) &&
              attribute.name.text === "onOpenChange"
          );
          const handler = onOpenChange?.initializer?.getText(sourceFile) ?? "";
          const dialogBody = node.getText(sourceFile);

          for (const match of handler.matchAll(/set([A-Z][A-Za-z0-9_]*)\((?:null|undefined)\)/g)) {
            const setterSuffix = match[1]!;
            const stateName = setterSuffix[0]!.toLowerCase() + setterSuffix.slice(1);
            const retainedPattern = new RegExp(`useRetainedDialogValue\\(\\s*${stateName}\\s*,`);
            if (dialogBody.includes(stateName) && !retainedPattern.test(source)) {
              const line =
                sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
              findings.push(`${path.relative(sourceRoot, file)}:${line} clears ${stateName}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
    }

    expect(findings).toEqual([]);
  });
});
