<!-- Authored by: Mohit Singh -->

# Efficiency Skills — token/action discipline

> Read once, apply always. Every technique here earns its keep by cutting tokens/turns **without** cutting
> correctness. This is how the codebase should be worked, not just how it should be written.

## Search before you read

`Grep`/`Glob` to locate the exact symbol/file first — never open a file "to look around." Once the location is
known, read targeted line ranges (`offset`/`limit`), not whole files.

## Prefer Edit over Write

For existing files, send only the diff (`old_string`/`new_string`), never a full-file rewrite. A full rewrite
costs tokens proportional to file size regardless of how small the actual change is.

## Delegate wide exploration, not narrow lookups

A dedicated Explore agent for "find every place X pattern is used" keeps the raw search transcript out of the
main context — only the distilled answer returns. Don't spawn an agent for a single known-location read; that's
pure overhead.

## Batch independent tool calls

Parallel `Read`/`Grep` calls when the results don't depend on each other. Sequential only when one result's
value determines the next call's arguments.

## Never re-verify what the harness already confirmed

Edit/Write tool results confirm success. Re-reading a file immediately after editing it "to check" is a pure
token cost with zero information gain — the harness would have errored if the edit failed.

## Summarize large output before it enters context

Test/build/log output over ~50 lines gets `grep`'d for the failure/signal, not pasted whole. Long DB query
results are paginated/`LIMIT`ed, never dumped in full.

## Terse docs, linked not duplicated

Skill files and READMEs state a rule once and point at the file that proves it (`file.ts:42`) rather than
reproducing code blocks that will drift from the source as the code evolves.

## One skill per concern, loaded on demand

Skills are split by layer (frontend / backend-node / backend-python / db / devops / security) so a frontend
task never pulls Python conventions into context, and vice versa.

## Small, focused commits

A diff scoped to one phase's deliverable (or one clear sub-step of it) reviews faster and re-reads cheaper than
a sprawling change touching every layer at once. This also makes `git log`/`git blame` actually useful later.

## Prefer structural checks over full-file diffs for verification

`tsc`/`mypy`/`pytest`/`ruff` exit codes, and a targeted `grep` (e.g. "no `mock-data` import remains", "no
`Lovable` mention in CLAUDE.md"), prove correctness far more cheaply than re-reading files end to end.

## Don't ask what you can verify

If a question is answerable by reading a file, running a command, or checking a config — do that instead of
asking. Reserve questions for genuine judgment calls the codebase can't answer on its own.
