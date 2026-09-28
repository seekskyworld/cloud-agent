/** 业务包静态清单；只导入可信部署代码，是否启用及资源绑定由部署配置决定。 */
import type { BusinessPackage } from "../packages/sdk/index.js";
import { starterPackage } from "./starter-package/index.js";
export const businessPackages: BusinessPackage[] = [
  starterPackage,
  // generated:packages
];
