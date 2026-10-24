import test from "node:test";
import assert from "node:assert/strict";
import { setup, principal } from "./helpers.js";

test("the task list can be narrowed to modules and a project so frequent tool tasks do not hide conversations", async () => {
  const c = await setup();
  try {
    const make = async (key: string, moduleId: string, projectId: string) => {
      const task = await c.service.create(
        principal,
        "report",
        { title: "x", values: [1] },
        key,
      );
      await c.db.pool.query(
        "UPDATE tasks SET module_id=$2, input=$3 WHERE id=$1",
        [task.id, moduleId, { projectId }],
      );
      return task.id;
    };
    const chat = await make("chat", "pipeline", "project-a");
    await make("other", "pipeline", "project-b");
    for (let i = 0; i < 55; i++) await make(`tool-${i}`, "tool", "project-a");
    const recent = await c.service.list(principal, 0);
    assert.ok(
      !recent.some((task) => task.id === chat),
      "pushed out without a filter",
    );
    const filtered = await c.service.list(principal, 0, {
      modules: ["pipeline"],
      projectId: "project-a",
    });
    assert.deepEqual(
      filtered.map((task) => task.id),
      [chat],
    );
  } finally {
    await c.close();
  }
});
