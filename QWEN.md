# OpenSpec UI (qwen-opsx-ui)

- Write OpenSpec planning artifacts (files under `openspec/changes/<change>/`) only with `write_file` or `edit`, never through shell redirection, `tee`, `cp`, `mv` or scripts.
- Every artifact write opens a confirmation dialog for the user. Do not try to avoid or work around it.
- If an artifact write was not allowed, do not repeat it unchanged: follow the user's feedback, or ask what to change with `ask_user_question`.
- Before writing an artifact, run `openspec instructions <artifact-id> --change "<name>"` as the workflow says; the UI uses it to show progress.
