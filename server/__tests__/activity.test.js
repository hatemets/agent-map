const test = require("node:test");
const assert = require("node:assert/strict");

const { describeActivity } = require("../lib/activity");

test("terminal activity uses a colon instead of an em dash", () => {
  const activity = describeActivity({
    records: [],
    status: "done",
    toolCalls: 48,
    activeMs: 1901000,
  });

  assert.equal(activity, "Done: 48 tools, 31m41s");
  assert.equal(activity.includes("—"), false);
});
