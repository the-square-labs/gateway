// Reads component facts straight from the TypeScript sources with the
// compiler API: cva variant tables (names, classes, defaults) and each
// exported component's own props with their types and doc comments.

import path from "node:path";

/** Finds the first `cva(base, { variants, defaultVariants })` call in a file. */
export function readCva(ts, program, file) {
  const source = program.getSourceFile(file);
  if (!source) return null;
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isCallExpression(node) && node.expression.getText(source) === "cva") {
      const [baseArg, configArg] = node.arguments;
      const base = baseArg && ts.isStringLiteralLike(baseArg) ? baseArg.text : "";
      const variants = {};
      const defaults = {};
      if (configArg && ts.isObjectLiteralExpression(configArg)) {
        for (const prop of configArg.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const key = prop.name.getText(source);
          if (key === "variants" && ts.isObjectLiteralExpression(prop.initializer)) {
            for (const group of prop.initializer.properties) {
              if (!ts.isPropertyAssignment(group) || !ts.isObjectLiteralExpression(group.initializer)) continue;
              const groupName = group.name.getText(source).replace(/^["']|["']$/g, "");
              variants[groupName] = {};
              for (const option of group.initializer.properties) {
                if (!ts.isPropertyAssignment(option)) continue;
                const optionName = option.name.getText(source).replace(/^["']|["']$/g, "");
                variants[groupName][optionName] = ts.isStringLiteralLike(option.initializer)
                  ? option.initializer.text
                  : option.initializer.getText(source);
              }
            }
          }
          if (key === "defaultVariants" && ts.isObjectLiteralExpression(prop.initializer)) {
            for (const option of prop.initializer.properties) {
              if (!ts.isPropertyAssignment(option)) continue;
              defaults[option.name.getText(source)] = option.initializer.getText(source).replace(/^["']|["']$/g, "");
            }
          }
        }
      }
      found = { base, variants, defaults };
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Package that declares a symbol, for "also accepts … from" notes. */
function declaringPackage(fileName) {
  const match = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(fileName);
  return match ? match[1] : null;
}

function jsDoc(ts, checker, symbol) {
  return ts.displayPartsToString(symbol.getDocumentationComment(checker)).replace(/\s+/g, " ").trim();
}

/**
 * Props of each named export of `entryFile`: own props (declared in the
 * product) with types, plus the packages the inherited ones come from.
 */
export function readExports(ts, program, entryFile, frontendDir) {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entryFile);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  const out = new Map();
  const typeFlags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!decl) continue;
    const type = checker.getTypeOfSymbolAtLocation(symbol, decl);
    const sourceFile = path.relative(frontendDir, decl.getSourceFile().fileName);
    const doc = jsDoc(ts, checker, symbol);
    let signature = type.getCallSignatures()[0];
    let kind = "function";
    if (!signature && type.getConstructSignatures().length > 0) {
      signature = type.getConstructSignatures()[0];
      kind = "class";
    }
    if (!signature) {
      out.set(exported.name, { name: exported.name, kind: "value", sourceFile, doc, type: checker.typeToString(type, undefined, typeFlags) });
      continue;
    }
    const firstParam = signature.getParameters()[0];
    let propsType = null;
    if (kind === "class") {
      const instance = signature.getReturnType();
      const propsSymbol = instance.getProperty("props");
      if (propsSymbol) propsType = checker.getTypeOfSymbolAtLocation(propsSymbol, decl);
    } else if (firstParam) {
      propsType = checker.getTypeOfSymbolAtLocation(firstParam, decl);
    }
    const typeParams = (signature.getTypeParameters() ?? []).map((param) => checker.typeToString(param));
    const own = [];
    const inherited = new Map();
    if (propsType) {
      for (const prop of checker.getPropertiesOfType(propsType)) {
        const propDecl = prop.valueDeclaration ?? prop.declarations?.[0];
        const file = propDecl?.getSourceFile().fileName ?? "";
        if (file.includes("/node_modules/")) {
          const pkg = declaringPackage(file) ?? "a library";
          const names = inherited.get(pkg) ?? [];
          names.push(prop.name);
          inherited.set(pkg, names);
          continue;
        }
        if (prop.name === "key" || prop.name === "ref") continue;
        const propType = checker.getTypeOfSymbolAtLocation(prop, propDecl ?? decl);
        const optional = Boolean(prop.flags & ts.SymbolFlags.Optional);
        let typeText = checker.typeToString(propType, undefined, typeFlags).replace(/\s+/g, " ");
        if (optional) typeText = typeText.replace(/ \| null \| undefined$/, " | null").replace(/ \| undefined$/, "");
        own.push({
          name: prop.name,
          optional,
          type: typeText,
          doc: jsDoc(ts, checker, prop),
        });
      }
    }
    // Stable order: the order the source declares them in.
    out.set(exported.name, {
      name: exported.name,
      kind,
      sourceFile,
      doc,
      typeParams,
      own,
      inherited: [...inherited.entries()]
        .map(([pkg, names]) => [pkg, names.length, names.sort()])
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      acceptsChildren: own.some((prop) => prop.name === "children") || inherited.size > 0,
    });
  }
  return out;
}

export function createProgram(ts, frontendDir, entryFile) {
  const configPath = path.join(frontendDir, "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  return ts.createProgram({
    rootNames: [entryFile],
    options: { ...parsed.options, noEmit: true, types: [] },
  });
}

/** Qualifies bare React type names so the documentation types read unambiguously. */
function qualifyReact(type) {
  return type.replace(/(?<![\w.])(ReactNode|ReactElement|CSSProperties|ElementType|ComponentType|RefObject|KeyboardEvent|MouseEvent|ChangeEvent|PointerEvent)\b/g, "React.$1");
}

function propLine(prop) {
  const doc = prop.doc ? `  /** ${prop.doc.replace(/\*\//g, "* /")} */\n` : "";
  const key = /^[A-Za-z_$][\w$]*$/.test(prop.name) ? prop.name : JSON.stringify(prop.name);
  return `${doc}  ${key}${prop.optional ? "?" : ""}: ${qualifyReact(prop.type)};`;
}

/** components/index.d.ts: documentation types for every export of the bundle. */
export function renderDts(exportsMeta, { namespace, summaries }) {
  const lines = [
    "// Generated from the Good Gateway frontend sources by scripts/design-system.",
    "// Documentation only: the props each export declares in the product, with the",
    "// packages its inherited props come from.",
    'import type * as React from "react";',
    "",
  ];
  const names = [];
  for (const meta of exportsMeta.values()) {
    names.push(meta.name);
    const summary = summaries.get(meta.name) ?? meta.doc;
    if (meta.kind === "value") {
      if (summary) lines.push(`/** ${summary} */`);
      lines.push(`export declare const ${meta.name}: ${meta.type};`, "");
      continue;
    }
    const generics = meta.typeParams.length ? `<${meta.typeParams.join(", ")}>` : "";
    const inherited = meta.inherited.length
      ? ` /* also accepts ${meta.inherited.map(([pkg, count, names]) => (pkg !== "@types/react" && count <= 16 ? `${names.join(", ")} from ${pkg}` : `${count} props from ${pkg}`)).join("; ")} */`
      : "";
    const header = [`/** ${summary || `${meta.name} (${meta.sourceFile}).`} Source: ${meta.sourceFile}. */`];
    lines.push(...header);
    lines.push(`export interface ${meta.name}Props${generics}${inherited} {`);
    for (const prop of meta.own) lines.push(propLine(prop));
    lines.push("}");
    lines.push(`export declare function ${meta.name}${generics}(props: ${meta.name}Props${generics ? `<${meta.typeParams.join(", ")}>` : ""}): React.ReactElement | null;`, "");
  }
  lines.push("declare global {", "  interface Window {", `    ${namespace}: {`);
  for (const name of names) lines.push(`      ${name}: typeof ${name};`);
  lines.push("    };", "  }", "}", "");
  return lines.join("\n");
}
