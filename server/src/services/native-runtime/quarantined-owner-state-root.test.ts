import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { quarantinedOwnerStateRoot } from "./native-session-executor.js";

describe("quarantinedOwnerStateRoot", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const scoped = () => { const d = mkdtempSync(join(tmpdir(), "owner-root-")); dirs.push(d); return d; };
  const withState = (root: string) => {
    mkdirSync(join(root, "control-plane"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "control-plane", "control-plane-state.json"), "{}");
  };

  it("keeps the live root when it still holds its control-plane state", () => {
    const root = scoped(); withState(root);
    expect(quarantinedOwnerStateRoot(root)).toBe(root);
  });

  it("uses the single continuity-break archive once the live state was retired", () => {
    const root = scoped(); const archive = join(root, "continuity-breaks", "1-a");
    mkdirSync(archive, { recursive: true, mode: 0o700 }); withState(archive);
    expect(quarantinedOwnerStateRoot(root)).toBe(archive);
  });

  it("stays on the live root when several archives make the owner ambiguous", () => {
    const root = scoped();
    for (const name of ["1-a", "2-b"]) {
      const a = join(root, "continuity-breaks", name);
      mkdirSync(a, { recursive: true, mode: 0o700 }); withState(a);
    }
    expect(quarantinedOwnerStateRoot(root)).toBe(root);
  });
});
