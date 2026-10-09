import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
type Query = { sql: string; parameters?: number; location: string };
export async function queries(path: string): Promise<Query[]> {
  const source = ts.createSourceFile(
    path,
    await readFile(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: Query[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "query"
    ) {
      const [sql, args] = node.arguments;
      if (
        sql &&
        (ts.isStringLiteral(sql) || ts.isNoSubstitutionTemplateLiteral(sql))
      )
        found.push({
          sql: sql.text,
          parameters: !args
            ? 0
            : ts.isArrayLiteralExpression(args) &&
                !args.elements.some(ts.isSpreadElement)
              ? args.elements.length
              : undefined,
          location: `${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
        });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}
export async function files(path: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await files(child)));
    else if (child.endsWith(".ts")) result.push(child);
  }
  return result;
}
