## Core (must have)

### maybe combine multiple tools so we dont have a lot of them.

1. list_conflicts()  
   Find conflicts from git index and/or scan markers in working tree. This is the entry point for the TUI.
2. get_conflict_context(conflict_file, conflict_id | start_line, end_line, window)  
   Returns a full slice around the conflict (markers + surrounding code) to show in TUI.
3. get_file_versions(file_path)
   Fetches base/ours/theirs (three‑way) content so you can show proper panes.
4. get_branch_intent(commit_hash_a, commit_hash_b, file_path | module)  
   Summarizes intent via commit messages/diffs for local reasoning.
5. propose_patch(conflict_file, resolution_code, format=unified_diff)  
   Generates a patch for review; do not auto‑apply.

## Validation (highly recommended)

- validate_resolution(file_path, mode=syntax|lint|tests)  
  Run a fast parse or lint check; avoid full test suite by default.
- revert_resolution(file_path) (or checkout_conflict_version)  
  Safety valve if validation fails or user cancels.

## Interaction / clarification

- ask_about_region(file_version, line_start, question, max_lines)  
  Useful when the agent is unsure which intent to prioritize.

## Resolution Strategy (AST + Intent)

1. Parse base/ours/theirs with Tree-sitter
   - Build incremental syntax trees for each version (avoid parsing conflict-marker text directly).
   - Compute changed ranges from `base -> ours` and `base -> theirs`.

2. Detect overlap type
   - Non-overlapping structural edits: auto-merge at node boundaries.
   - Overlapping structural edits: generate multiple candidates (ours/theirs/hybrid splice).

3. Resolve overlaps with intent
   - Use `get_branch_intent(commit_hash_a, commit_hash_b, file_path | module)` to infer each branch's behavioral intent.
   - If still ambiguous, use `ask_about_region(file_version, line_start, question, max_lines)` and/or an explicit intent prompt to collect expected behavior + edge cases.

4. Candidate scoring
   - Syntax validity (must parse)
   - Intent alignment (branch intent + user intent)
   - Minimal blast radius (smallest safe change)
   - Confidence threshold for automatic recommendation

5. Patch-first output
   - Always emit `propose_patch(conflict_file, resolution_code, format=unified_diff)` with rationale.
   - Do not auto-apply by default.

6. Validation and safety
   - Run `validate_resolution(file_path, mode=syntax|lint|tests)` in escalating order.
   - If validation fails or confidence is low, keep conflict unresolved and surface top candidates.
   - Use `revert_resolution(file_path)` as rollback path.
