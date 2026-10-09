/** SDK v1 的稳定导出面；业务包不需要导入运行时、数据库或应用内部实现。 */
export * from "../contracts/index.js";
export { defineBusinessPackage, SDK_MAJOR } from "../business/index.js";
export type {
  BusinessPackage,
  BusinessServices,
  BusinessDeployment,
  Requirement,
} from "../business/index.js";
export { defineExtension } from "../extensions/registry.js";
export type { Extension } from "../extensions/registry.js";

export { ExecutionFailure } from "../contracts/failure.js";
export type { FailureCategory } from "../contracts/failure.js";

export type {
  ContextProvider,
  ContextDocument,
  ContextReference,
} from "../contracts/context.js";
export {
  ExtractedReference,
  SourceRange,
  restoreSourceRanges,
  sourceDigest,
} from "../contracts/source.js";

export { definePort } from "../business/application.js";
export type {
  BusinessRoute,
  BusinessPublicRead,
  BusinessPage,
  BusinessJob,
  BusinessMigration,
  BusinessInstance,
  BusinessDataResource,
  PortToken,
} from "../business/application.js";

export type {
  BusinessMailInput,
  BusinessMailPolicy,
} from "../mail/business-contracts.js";
export type {
  MailMessage,
  MailDelivery,
  MailProvider,
} from "../mail/contracts.js";
export type { BusinessCheck } from "../business/checks.js";
