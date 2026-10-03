import assert from "node:assert/strict";
import { test } from "node:test";
import { renderAction, runAction, setSoftwareGate, setSoftwareOpenHandler } from "../src/gui/bridge.ts";

const occupied = {
  instances: [{ pid: 22, projectBasename: "final", projectPath: "/tmp/ws/projects/final.kdenlive" }],
};

test("software gate blocks render before invoking command handler", async () => {
  setSoftwareGate({ occupied: () => occupied });
  const result = await runAction(renderAction("/tmp/nonexistent-workspace", "video"));
  assert.equal(result.ok, false);
  assert.equal(result.blockedBy, "software-in-use");
  assert.deepEqual(result.instances, occupied.instances);
  setSoftwareGate(null);
});

test("explicit force passes the gate; no gate retains ordinary command behavior", async () => {
  setSoftwareGate({ occupied: () => occupied });
  const action = renderAction("/tmp/nonexistent-workspace", "video");
  const forced = await runAction({ ...action, force: true });
  assert.notEqual(forced.blockedBy, "software-in-use");
  assert.equal(forced.ok, false); // nonexistent workspace fails in the normal command handler

  setSoftwareGate(null);
  const ordinary = await runAction(action);
  assert.notEqual(ordinary.blockedBy, "software-in-use");
});

test("software_open uses its injected authorized handler", async () => {
  setSoftwareOpenHandler(async (dir) => ({ ok: true, message: `opened:${dir}` }));
  const result = await runAction({
    kind: "software_open", label: "打开工程", argv: ["--workspace", "/tmp/ws"], effectHint: "确认后打开",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.lines, ["opened:/tmp/ws"]);
  setSoftwareOpenHandler(null);
});
