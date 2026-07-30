import ts from "typescript";

const SOURCE_FILES = import.meta.glob("../**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("vertical form-field spacing", () => {
  it("uses space-y-1.5 for every stacked label and control", () => {
    const violations: string[] = [];

    for (const [file, source] of Object.entries(SOURCE_FILES)) {
      if (file.endsWith(".test.tsx")) continue;
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );

      const visit = (node: ts.Node) => {
        if (ts.isJsxElement(node) && tagName(node.openingElement) === "label") {
          checkLabel(node, sourceFile, violations);
        }
        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
    }

    expect(violations).toEqual([]);
  });
});

function checkLabel(label: ts.JsxElement, sourceFile: ts.SourceFile, violations: string[]) {
  const ownClassName = className(label.openingElement);
  if (ownClassName.includes("flex") && !ownClassName.includes("flex-col")) return;

  if (ownClassName.includes("space-y-")) {
    if (!ownClassName.includes("space-y-1.5")) {
      violations.push(location(sourceFile, label, ownClassName));
    }
    return;
  }

  const parent = label.parent;
  if (!ts.isJsxElement(parent) || tagName(parent.openingElement) !== "div") return;

  const parentClassName = className(parent.openingElement);
  if (parentClassName.includes("flex") && !parentClassName.includes("flex-col")) return;

  const children = parent.children.filter(
    (child) => !ts.isJsxText(child) || child.getText().trim().length > 0
  );
  if (children[0] !== label || children.length < 2) return;

  if (!parentClassName.includes("space-y-1.5")) {
    violations.push(location(sourceFile, label, parentClassName || "missing wrapper class"));
  }
}

function tagName(opening: ts.JsxOpeningLikeElement) {
  return opening.tagName.getText();
}

function className(opening: ts.JsxOpeningLikeElement) {
  const attribute = opening.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === "className"
  );
  return attribute?.initializer?.getText() ?? "";
}

function location(sourceFile: ts.SourceFile, node: ts.Node, classNameValue: string) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  return `${sourceFile.fileName.replace(/^\.\.\//, "")}:${line} (${classNameValue})`;
}
