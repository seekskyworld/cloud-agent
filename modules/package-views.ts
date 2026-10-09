/** 业务 UI 只在浏览器静态装配，与服务端业务清单分别打包。 */
import type { ModuleView } from "../packages/ui/index.js";
import { starterViews } from "./starter-package/views.js";
export const packageViews: ModuleView[] = [...starterViews];
