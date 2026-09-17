import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'packages/backend/package.json'));
const ts = require('typescript');
const manifest = JSON.parse(readFileSync(join(root, 'config/editions/extraction.json'), 'utf8'));
const errors = [];
let contracts = 0;
for (const name of manifest.removedBackendTests ?? []) {
  if (existsSync(join(root, 'packages/backend/tests', name))) errors.push(`Private test remains: ${name}`);
}
for (const name of manifest.typeOnlyBackendSources ?? []) {
  const file = join(root, 'packages/backend/src', name);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    const typeOnlyImport = ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly;
    const typeOnlyExport = ts.isExportDeclaration(statement) && (statement.isTypeOnly || (!statement.moduleSpecifier && statement.exportClause?.elements?.length === 0));
    const declaration = ts.isFunctionDeclaration(statement) && !statement.body && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);
    const variableDeclaration = ts.isVariableStatement(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
      && statement.declarationList.declarations.every((declaration) => !declaration.initializer);
    const classDeclaration = ts.isClassDeclaration(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
      && statement.members.every((member) => !member.body && !member.initializer
        && !ts.isClassStaticBlockDeclaration(member)
        && (!member.name || !ts.isComputedPropertyName(member.name)));
    if (!typeOnlyImport && !typeOnlyExport && !declaration && !variableDeclaration && !classDeclaration && !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) {
      errors.push(`Runtime implementation in type-only contract: ${name}`);
    }
  }
}
for (const name of manifest.removedBackendSources) {
  if (existsSync(join(root, 'packages/backend/src', name))) errors.push(`Private source remains: ${name}`);
  const stem = name.replace(/\.ts$/, '');
  for (const suffix of ['.js', '.js.map', '.d.ts', '.d.ts.map']) {
    if (existsSync(join(root, 'packages/backend/dist', stem + suffix))) errors.push(`Stale private build output: ${stem + suffix}`);
  }
}
for (const contract of manifest.backendContracts) {
  const file = join(root, 'packages/backend/src', contract.path);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const declaration of source.statements.filter(ts.isClassDeclaration)) {
    for (const member of declaration.members) {
      if (contract.typeOnlyProperties && ts.isPropertyDeclaration(member) && !member.initializer && member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) continue;
      if (contract.emptyConstructor && ts.isConstructorDeclaration(member) && member.body?.statements.length === 0) continue;
      if (contract.eventEmitterConstructor && ts.isConstructorDeclaration(member)) {
        const expression = member.body?.statements.length === 1 && member.body.statements[0].expression;
        if (expression && ts.isCallExpression(expression) && expression.expression.kind === ts.SyntaxKind.SuperKeyword && expression.arguments.length === 0
          && declaration.heritageClauses?.some((clause) => clause.types.some((type) => type.expression.getText(source) === 'EventEmitter'))) continue;
      }
      const name = member.name?.getText(source);
      if (contract.onlyMethods && !contract.onlyMethods.includes(name)) continue;
      if (contract.sharedMethods.includes(name)) continue;
      if (contract.emptyMethods?.includes(name) && ts.isMethodDeclaration(member) && member.body?.statements.length === 0) continue;
      if (!ts.isMethodDeclaration(member) || !member.body) {
        errors.push(`Unexpected member in Community contract: ${contract.path}:${name}`);
        continue;
      }
      const statements = member.body.statements;
      const expression = statements.length === 1 && (ts.isReturnStatement(statements[0]) || ts.isExpressionStatement(statements[0])) && statements[0].expression;
      if (!expression || !ts.isCallExpression(expression) || expression.expression.getText(source) !== 'commercialModuleUnavailable' || expression.arguments.length) {
        errors.push(`Paid implementation in Community contract: ${contract.path}:${name}`);
      }
      contracts++;
    }
  }
}
if (process.argv.includes('--require-complete') && (!manifest.complete || manifest.pendingDomains.length)) {
  errors.push(`Commercial extraction is still in progress: ${manifest.pendingDomains.join(', ')}`);
}
if (errors.length) {
  process.stderr.write(errors.join('\n') + '\n');
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ removedSources: manifest.removedBackendSources.length, unavailableContracts: contracts,
    complete: manifest.complete, pendingDomains: manifest.pendingDomains }));
}
