/** 按声明的方言校验；缺省保持 Draft-07，不能删除 $schema 后忽略新版约束。 */
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

export function compileJsonSchema(schema: object | boolean) {
  const dialect =
    typeof schema === "object" && "$schema" in schema
      ? schema.$schema
      : undefined;
  const options = { strict: false, allErrors: false };
  const validator =
    dialect === "https://json-schema.org/draft/2020-12/schema"
      ? new Ajv2020(options)
      : new Ajv(options);
  return validator.compile(schema);
}
