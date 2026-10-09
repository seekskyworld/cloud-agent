// 导入边界检查覆盖图外目标；值依赖图只用于生产源码循环检测。
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

async function files(root) {
  const result = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const file = `${root}/${item.name}`;
    if (item.isDirectory()) result.push(...(await files(file)));
    else if (/\.tsx?$/.test(file)) result.push(file);
  }
  return result;
}

const sourceFiles = (
  await Promise.all(["packages", "apps", "adapters", "modules"].map(files))
).flat();
const known = new Set(sourceFiles);
function resolve(from, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.normalize(path.join(path.dirname(from), specifier));
  return [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
  ].find((file) => known.has(file));
}
function isTypeOnly(node) {
  if (ts.isExportDeclaration(node))
    return Boolean(
      node.isTypeOnly ||
        (node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length &&
          node.exportClause.elements.every((item) => item.isTypeOnly)),
    );
  if (node.importClause?.isTypeOnly) return true;
  // 默认导入仍是值依赖，即使命名导入全部标记为 type。
  if (node.importClause?.name) return false;
  const bindings = node.importClause?.namedBindings;
  return Boolean(
    bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length &&
      bindings.elements.every((item) => item.isTypeOnly),
  );
}

const edges = [];
const dependencies = [];
for (const file of sourceFiles) {
  const source = ts.createSourceFile(
    file,
    await readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const add = (specifier, typeOnly = false) => {
    // tests/project 和第三方包不在 known 中，不能因无法解析内部边而跳过隔离检查。
    const dependency = specifier.startsWith(".")
      ? path.normalize(path.join(path.dirname(file), specifier))
      : specifier;
    dependencies.push({ from: file, to: dependency });
    const target = resolve(file, specifier);
    if (target) edges.push({ from: file, to: target, typeOnly });
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      add(node.moduleSpecifier.text, isTypeOnly(node));
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    )
      add(node.moduleReference.expression.text, node.isTypeOnly);
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      add(node.argument.literal.text, true);
    if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    )
      add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const forbidden = dependencies.filter((edge) => {
  if (/(?:^|\/)(?:tests|project)\//.test(edge.to)) return true;
  if (!edge.from.startsWith("packages/")) return false;
  if (
    /(?:^|\/)(?:modules|apps|adapters)\//.test(edge.to) ||
    /^(?:@earendil-works\/pi-ai|openai|@anthropic-ai\/sdk|@google\/(?:genai|generative-ai))(?:\/|$)/.test(
      edge.to,
    )
  )
    return true;
  if (
    /(?:^|\/)api\//.test(edge.to) &&
    /^(?:packages\/(runtime|persistence))\//.test(edge.from)
  )
    return true;
  if (
    edge.to.startsWith("packages/persistence/") &&
    (edge.from.startsWith("packages/connectors/") ||
      /^packages\/runtime\/(ports|model-ledger|model-lifecycle|worker)\.ts$/.test(
        edge.from,
      ))
  )
    return true;
  return (
    /(runtime|persistence|business|api)\//.test(edge.to) &&
    edge.from.startsWith("packages/contracts/")
  );
});
if (forbidden.length)
  throw new Error(
    `Forbidden core dependency: ${forbidden.map((edge) => `${edge.from} -> ${edge.to}`).join(", ")}`,
  );

function valueCycles(nodes, graphEdges) {
  const graph = new Map(nodes.map((node) => [node, []]));
  for (const edge of graphEdges)
    if (!edge.typeOnly) graph.get(edge.from)?.push(edge.to);
  let sequence = 0;
  const index = new Map(),
    low = new Map(),
    stack = [],
    active = new Set(),
    cycles = [];
  const visit = (node) => {
    index.set(node, sequence);
    low.set(node, sequence++);
    stack.push(node);
    active.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (active.has(next))
        low.set(node, Math.min(low.get(node), index.get(next)));
    }
    if (low.get(node) === index.get(node)) {
      const component = [];
      let item;
      do {
        item = stack.pop();
        active.delete(item);
        component.push(item);
      } while (item !== node);
      if (component.length > 1) cycles.push(component.sort());
    }
  };
  for (const node of nodes) if (!index.has(node)) visit(node);
  return cycles;
}
const cycles = valueCycles(sourceFiles, edges);
if (cycles.length)
  throw new Error(
    `Value import cycle: ${cycles.map((cycle) => cycle.join(" <-> ")).join("; ")}`,
  );
process.stdout.write(
  `Architecture boundaries passed (${sourceFiles.length} files, ${edges.length} resolved edges)\n`,
);
