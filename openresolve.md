## Core (must have)  
- list_conflicts()  
  Find conflicts from git index and/or scan markers in working tree. This is the entry point for the TUI.  
- get_conflict_context(conflict_file, conflict_id | start_line, end_line, window)  
  Returns a full slice around the conflict (markers + surrounding code) to show in TUI.  
- get_file_versions(file_path)  
  Fetches base/ours/theirs (three‑way) content so you can show proper panes.  
- get_branch_intent(commit_hash_a, commit_hash_b, file_path | module)  
  Summarizes intent via commit messages/diffs for local reasoning.  
- propose_patch(conflict_file, resolution_code, format=unified_diff)  
  Generates a patch for review; do not auto‑apply.  
- preview_patch(conflict_file, resolution_code)  
  Shows a diff preview to the user.  
- apply_patch(conflict_file, resolution_code)  
  Applies the final resolution after explicit confirmation.  
## Validation (highly recommended)  
- validate_resolution(file_path, mode=syntax|lint|tests)  
  Run a fast parse or lint check; avoid full test suite by default.  
- revert_resolution(file_path) (or checkout_conflict_version)  
  Safety valve if validation fails or user cancels.  
## Interaction / clarification  
- ask_about_region(file_version, line_start, question, max_lines)  
  Useful when the agent is unsure which intent to prioritize.  
## Nice to have (for quality)  
- get_related_commits(file_path, range)  
  Finds the relevant commit history.  
- get_symbol_context(file_path, symbol)  
  Tree‑sitter based for function/class context.  
- open_in_editor(file_path, line)  
  Jump to local editor if user prefers manual resolution.
