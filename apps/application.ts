/** API、Worker 与运维工具共用的部署装配入口；业务宿主在此注入扩展。 */
export { createContainer as createApplication } from "./container.js";
