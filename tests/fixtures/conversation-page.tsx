/** 只由浏览器测试服务打包，不注册到生产页面。 */
import { createRoot } from "react-dom/client";
import { CloudAgentClient } from "../../packages/api/client.js";
import { ConversationPanel } from "../../packages/ui/conversation.js";

createRoot(document.getElementById("root")!).render(
  <ConversationPanel
    client={new CloudAgentClient()}
    moduleId="browser-conversation"
  />,
);
