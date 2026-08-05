import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("a synchronized workspace rechecks the current day", async () => {
  const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(refreshWorkspace && !archiveDayView\) \{[\s\S]*?void checkForAutomaticDayRollover\(\);/
  );
});

test("a visible Start Today control can trigger a manual rollover", async () => {
  const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(source, /id="startTodayButton"[^>]*>Start Today<\/button>/);
  assert.match(source, /startTodayButton\.addEventListener\("click", \(\) => void startCurrentDayManually\(\)\)/);
  assert.match(source, /async function startCurrentDayManually\(\)[\s\S]*?await checkForAutomaticDayRollover\(\)/);
});
