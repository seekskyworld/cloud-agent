/** 用户在真实浏览器完成任务创建、等待输入、审批和结果下载。 */
import { test, expect } from "@playwright/test";
async function openWorkspace(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "任务工作台" })).toBeVisible();
}
test("报告等待补充、生成产物并下载", async ({ page }) => {
  await openWorkspace(page);
  await page.getByLabel("选择助手").selectOption("report");
  await page.getByLabel("values 1", { exact: true }).fill("10");
  await page.getByLabel("values 2", { exact: true }).fill("20");
  await page.getByLabel("values 3", { exact: true }).fill("30");
  await page
    .getByRole("button", { name: "移除 values 4", exact: true })
    .click();
  await page.getByRole("button", { name: "创建任务 →", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "任务正在等待" }),
  ).toBeVisible();
  await page
    .locator(".wait-box")
    .getByLabel("title", { exact: true })
    .fill("浏览器验收报告");
  await page.getByRole("button", { name: "提交补充" }).click();
  await expect(page.locator(".detail .badge")).toHaveText("已完成");
  await expect(page.locator(".detail")).toContainText('"sum": 60');
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载产物" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.json$/);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/workbench-desktop.png",
    fullPage: true,
  });
});
test("确认示例展示实际参数，确认后才执行工具", async ({ page }) => {
  await openWorkspace(page);
  await page.getByLabel("选择助手").selectOption("reviewed-report");
  await page.getByRole("button", { name: "高级 JSON", exact: true }).click();
  await page
    .getByLabel("任务内容（JSON）")
    .fill(JSON.stringify({ title: "确认验收", values: [10, 20] }));
  await page.getByRole("button", { name: "创建任务 →", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "需要你的确认" }),
  ).toBeVisible();
  await expect(page.locator(".wait-box")).toContainText("确认验收");
  await page.getByRole("button", { name: "确认执行", exact: true }).click();
  await expect(page.locator(".detail .badge")).toHaveText("已完成");
  await expect(page.locator(".detail")).toContainText('"sum": 30');
});
test("小屏直接进入，刷新仍无需令牌", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page);
  await page.getByLabel("选择助手").selectOption("text");
  await page.getByLabel("text", { exact: true }).fill("移动表单验收");
  await page.getByRole("button", { name: "创建任务 →", exact: true }).click();
  await expect(page.locator(".detail .badge")).toHaveText("已完成");
  await expect(page.locator(".text-result")).toContainText("移动表单验收");
  const size = await page.evaluate(() => ({
    body: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(size.body).toBeLessThanOrEqual(size.viewport);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/workbench-mobile.png",
    fullPage: true,
  });
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "任务工作台" })).toBeVisible();
  await expect(page.getByLabel("访问令牌")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});
test("超级管理员配置成员角色和能力，变更原因进入审计", async ({ page }) => {
  await openWorkspace(page);
  await page
    .locator("aside")
    .getByRole("button", { name: "权限管理", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "权限管理", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("受保护", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新增成员", exact: true }).click();
  await page.getByLabel("成员标识").fill("browser-operator");
  await page.getByLabel("管理角色").selectOption("admin");
  await page.getByLabel("report:run", { exact: true }).check();
  await page.getByLabel("变更原因").fill("浏览器授权验收");
  await page.getByRole("button", { name: "保存权限", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "权限已保存" }),
  ).toBeVisible();
  await expect(page.locator(".access-audit")).toContainText("浏览器授权验收");
  await page
    .getByRole("button", { name: "编辑 browser-operator", exact: true })
    .click();
  await page.getByLabel("管理角色").selectOption("member");
  await page.getByLabel("启用成员", { exact: true }).uncheck();
  await page.getByLabel("变更原因").fill("撤销管理员并停用");
  await page.getByRole("button", { name: "保存权限", exact: true }).click();
  await expect(page.locator(".access-audit")).toContainText("撤销管理员并停用");
  await expect(
    page.locator(".member-list").getByText("成员 · 已停用", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/administration-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page
    .locator(".mobile-pages")
    .getByRole("button", { name: "权限管理", exact: true })
    .click();
  await expect(page.locator(".member-list")).toContainText("browser-operator");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/administration-mobile.png",
    fullPage: true,
  });
});

test("独立业务包页面显示报告并鉴权下载文件，手机无横向溢出", async ({
  page,
}) => {
  await openWorkspace(page);
  await page.getByLabel("选择助手").selectOption("starter-report");
  await page.getByLabel("text", { exact: true }).fill("业务包浏览器验收");
  await page.getByRole("button", { name: "创建任务 →", exact: true }).click();
  await expect(page.locator(".detail .badge")).toHaveText("已完成");
  await expect(page.locator(".text-result")).toContainText("报告已生成");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /下载文件 · report.txt/ }).click();
  const result = await download;
  expect(result.suggestedFilename()).toBe("report.txt");
  const stream = await result.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toContain("业务包浏览器验收");
  await page.screenshot({
    path: "test-results/business-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/business-mobile.png",
    fullPage: true,
  });
});

test("运行治理页面在桌面及手机可用", async ({ page }) => {
  await openWorkspace(page);
  await page
    .locator("aside")
    .getByRole("button", { name: "运行治理", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "部署差异" })).toBeVisible();
  await page.screenshot({
    path: "test-results/governance-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator(".mobile-pages")
    .getByRole("button", { name: "运行治理", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "工作区运行状态" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/governance-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("未知写入可凭外部回执核实完成，页面不重新发送工具", async ({ page }) => {
  await openWorkspace(page);
  await page.getByLabel("选择助手").selectOption("browser-unknown");
  await page.getByRole("button", { name: "创建任务 →", exact: true }).click();
  await expect(
    page.getByText("存在结果未确认的业务动作", { exact: false }),
  ).toBeVisible();
  await page.getByText("核实外部执行结果", { exact: true }).click();
  await page.getByLabel("核实结论").selectOption("succeeded");
  await page.getByLabel("外部回执").fill("browser-receipt");
  await page.getByLabel("核实原因").fill("已在替身业务系统确认成功");
  await page.getByLabel("已确认结果（JSON）").fill('{"ok":true}');
  await page.getByRole("button", { name: "提交核实", exact: true }).click();
  await expect(page.locator(".detail .badge")).toHaveText("已完成");
});

test("模型失联提示与任务取消状态分别展示，手机不溢出", async ({ page }) => {
  await openWorkspace(page);
  await page.getByLabel("选择助手").selectOption("browser-model-unknown");
  await page.getByRole("button", { name: "创建任务 →", exact: true }).click();
  const warning = page.getByText("模型请求的远端状态尚未确认", {
    exact: false,
  });
  await expect(warning).toBeVisible();
  await page.getByRole("button", { name: "取消任务", exact: true }).click();
  await expect(page.locator(".detail .badge")).toHaveText("已取消");
  await expect(warning).toBeVisible();
  await page.screenshot({
    path: "test-results/model-unknown-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(warning).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/model-unknown-mobile.png",
    fullPage: true,
  });
});
