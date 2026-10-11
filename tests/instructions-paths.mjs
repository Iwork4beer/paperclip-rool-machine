import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const adapter = await import(pathToFileURL(path.join(packageRoot, "adapter", "index.js")));
const { resolveInstructionsPaths } = adapter;

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
    return true;
  });
}

const canonicalRoot = "/paperclip/instances/default/companies/company-1/agents/agent-1/instructions";

// Paperclip managed-run materialization: entry is rewritten into a per-run
// directory but instructionsRootPath still points at the canonical bundle.
{
  const materializedRoot = "/tmp/paperclip-run-123/instructions";
  const resolved = resolveInstructionsPaths({
    instructionsBundleMode: "managed",
    instructionsRootPath: canonicalRoot,
    instructionsEntryFile: "AGENTS.md",
    instructionsFilePath: `${materializedRoot}/AGENTS.md`,
  });
  assert.deepEqual(resolved, {
    entryFile: `${materializedRoot}/AGENTS.md`,
    rootPath: materializedRoot,
    entryName: "AGENTS.md",
    mode: "managed",
  });
}

// Nested managed entry: rebase to the materialized bundle root, not the entry
// directory, so sibling/top-level instruction files remain transportable.
{
  const materializedRoot = "/tmp/paperclip-run-456/instructions";
  const resolved = resolveInstructionsPaths({
    instructionsBundleMode: "managed",
    instructionsRootPath: canonicalRoot,
    instructionsEntryFile: "roles/worker/AGENTS.md",
    instructionsFilePath: `${materializedRoot}/roles/worker/AGENTS.md`,
  });
  assert.equal(resolved.rootPath, materializedRoot);
  assert.equal(resolved.entryFile, `${materializedRoot}/roles/worker/AGENTS.md`);
  assert.equal(resolved.entryName, "roles/worker/AGENTS.md");
}

// Traversal in the logical entry path is never accepted, including managed
// materialization where rebasing is otherwise allowed.
expectCode(() => resolveInstructionsPaths({
  instructionsBundleMode: "managed",
  instructionsRootPath: canonicalRoot,
  instructionsEntryFile: "../AGENTS.md",
  instructionsFilePath: "/tmp/paperclip-run-789/AGENTS.md",
}), "instructions_entry_invalid");

// A managed path outside the canonical root must still match the exact logical
// entry suffix; this prevents arbitrary rebasing to unrelated files.
expectCode(() => resolveInstructionsPaths({
  instructionsBundleMode: "managed",
  instructionsRootPath: canonicalRoot,
  instructionsEntryFile: "roles/worker/AGENTS.md",
  instructionsFilePath: "/tmp/unrelated/AGENTS.md",
}), "instructions_materialized_entry_mismatch");

// External bundles are not per-run materialized. An entry outside their
// configured root remains an error.
expectCode(() => resolveInstructionsPaths({
  instructionsBundleMode: "external",
  instructionsRootPath: "/srv/paperclip/instructions",
  instructionsEntryFile: "AGENTS.md",
  instructionsFilePath: "/srv/other/AGENTS.md",
}), "instructions_entry_outside_root");

// Prefix similarity is not containment: /instructions-escape must not be
// accepted as a child of /instructions.
expectCode(() => resolveInstructionsPaths({
  instructionsBundleMode: "external",
  instructionsRootPath: "/srv/paperclip/instructions",
  instructionsEntryFile: "AGENTS.md",
  instructionsFilePath: "/srv/paperclip/instructions-escape/AGENTS.md",
}), "instructions_entry_outside_root");

// Existing correctly paired paths retain their configured root.
{
  const resolved = resolveInstructionsPaths({
    instructionsBundleMode: "managed",
    instructionsRootPath: canonicalRoot,
    instructionsEntryFile: "AGENTS.md",
    instructionsFilePath: `${canonicalRoot}/AGENTS.md`,
  });
  assert.equal(resolved.rootPath, canonicalRoot);
  assert.equal(resolved.entryFile, `${canonicalRoot}/AGENTS.md`);
}

console.log("PASS: managed Instructions path rebasing and containment regression cases.");
