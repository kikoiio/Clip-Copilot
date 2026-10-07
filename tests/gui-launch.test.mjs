import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { isSandboxFailure, launchGui } from "../scripts/gui-launch.mjs";

const suidError = "[123:FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166] The SUID sandbox helper binary was found, but is not configured correctly.\n";

function fixture(outcomes, extra = {}) {
  const calls = [];
  const signals = [];
  const signalSource = new EventEmitter();
  let output = "";
  const options = {
    executable: "/fake/electron",
    platform: "linux",
    signalSource,
    stderr: { write: (chunk) => { output += chunk.toString(); } },
    spawnProcess: (executable, args, options) => {
      calls.push({ executable, args, options });
      const outcome = outcomes[calls.length - 1];
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (signal) => {
        signals.push(signal);
        queueMicrotask(() => child.emit("close", null, signal));
      };
      queueMicrotask(() => {
        if (outcome.interrupt) signalSource.emit(outcome.interrupt);
        else if (outcome.error) child.emit("error", outcome.error);
        else {
          child.stderr.emit("data", Buffer.from(outcome.stderr ?? ""));
          child.emit("close", outcome.code ?? null, outcome.signal ?? null);
        }
      });
      return child;
    },
    ...extra,
  };
  return { options, calls, signals, signalSource, output: () => output };
}

test("Linux SUID failure retries once, preserves arguments, and clears Electron Node mode", async () => {
  const f = fixture([{ stderr: suidError, signal: "SIGTRAP" }, { code: 0 }], {
    args: ["--debug", "custom-argument"], env: { ELECTRON_RUN_AS_NODE: "1", PATH: "/bin" },
  });
  assert.deepEqual(await launchGui(f.options), { code: 0, signal: null });
  assert.deepEqual(f.calls.map((call) => call.args), [
    [".", "--debug", "custom-argument"], ["--no-sandbox", ".", "--debug", "custom-argument"],
  ]);
  assert.deepEqual(f.calls[0].options.env, { PATH: "/bin" });
  assert.match(f.output(), /重试一次/);
  assert.equal(f.signalSource.listenerCount("SIGINT"), 0);
});

test("namespace sandbox errors are recognized only with explicit diagnostics", () => {
  assert.equal(isSandboxFailure("Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted"), true);
  assert.equal(isSandboxFailure("[FATAL:zygote_host_impl_linux.cc:126] No usable sandbox!"), true);
  assert.equal(isSandboxFailure("Application error: sandbox configuration is invalid"), false);
});

test("ordinary crashes, successful exits, other platforms and explicit no-sandbox never retry", async () => {
  for (const [outcome, extra] of [
    [{ stderr: "Application error", code: 2 }, {}],
    [{ stderr: "segmentation fault", signal: "SIGSEGV" }, {}],
    [{ stderr: suidError, code: 0 }, {}],
    [{ stderr: suidError, code: 1 }, { platform: "darwin" }],
    [{ stderr: suidError, code: 1 }, { args: ["--no-sandbox"] }],
  ]) {
    const f = fixture([outcome], extra);
    const result = await launchGui(f.options);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(result, { code: outcome.code ?? null, signal: outcome.signal ?? null });
  }
});

test("second failure is returned without a third attempt", async () => {
  const f = fixture([{ stderr: suidError, signal: "SIGTRAP" }, { stderr: suidError, code: 9 }]);
  assert.deepEqual(await launchGui(f.options), { code: 9, signal: null });
  assert.equal(f.calls.length, 2);
});

test("SIGINT and SIGTERM are forwarded to Electron and suppress retries", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const f = fixture([{ interrupt: signal }]);
    assert.deepEqual(await launchGui(f.options), { code: null, signal });
    assert.deepEqual(f.signals, [signal]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.signalSource.listenerCount(signal), 0);
  }
});

test("spawn errors are reported and signal listeners are cleaned up", async () => {
  const f = fixture([{ error: new Error("ENOENT") }]);
  await assert.rejects(launchGui(f.options), /ENOENT/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.signalSource.listenerCount("SIGTERM"), 0);
});
