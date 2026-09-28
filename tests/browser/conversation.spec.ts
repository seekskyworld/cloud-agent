import { test, expect } from "@playwright/test";

for (const valid of [true, false])
  test(`对话历史同步${valid ? "成功" : "失败"}状态`, async ({ page }) => {
    await page.goto("/__fixtures/conversation");
    await page
      .getByLabel("消息", { exact: true })
      .fill(valid ? "你好" : "invalid");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      page.getByLabel("历史请求").locator("option:checked"),
    ).toContainText(valid ? "已完成" : "未完成");
    if (valid) {
      await expect(page.locator(".agent-messages")).toContainText(
        "你好，任务已完成。",
      );
      await page.screenshot({
        path: "test-results/conversation-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: "test-results/conversation-mobile.png",
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } else {
      await expect(page.getByRole("status")).toContainText(
        "MODEL_OUTPUT_INVALID",
      );
    }
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
