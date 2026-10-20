# Фикстуры payload хуков Qwen Code 0.25.2

`payloads/*.json` сняты с настоящего Qwen Code 0.25.2 (`@qwen-code/qwen-code@0.25.2`). Модель в этих прогонах — фейковая: она отдаёт заранее заданные вызовы инструментов (`test/harness/fake-model.mjs`). Payload записывал отладочный хук `test/harness/capture-hook.mjs`, интерактивный TUI управлялся через pty (`test/harness/tui-driver.py`). Пути нормализованы: проект — `/work/proj`, домашний каталог — `/home/user`, расширение — `/ext/qwen-opsx-ui`. Длинные строки обрезаны.

Прогоны:

| Прогон | Режим | Что делали | Фикстуры |
|---|---|---|---|
| 1 | headless, `yolo` | `/opsx-propose demo change` → shell `openspec status`/`instructions` → `write_file`/`edit` proposal → `tool_search` + `tool_call mcp__slow__wait` → `skill openspec-explore` → неудачный `edit` | `UserPrompt*`, `PreToolUse-*`, `PostToolUse-*`, `PostToolUseFailure-edit`, `PostToolBatch-write_file-approved`, `SessionStart-startup` |
| A | TUI, `default` + пробный `ask`-хук | `/opsx-propose demo` → `write_file` → **Esc** в диалоге | `PostToolBatch-write_file-rejected`, `Notification-idle-turn-end` |
| B | TUI, `yolo` + пробный `ask`-хук | `/opsx-propose demo` → `write_file` → **Enter** («Да, разрешить один раз») | `PermissionRequest-write_file-yolo-ask`, `Stop` |
| C | TUI, `default` | вызов MCP → диалог разрешения → Enter | `PermissionRequest-mcp`, `PostToolUse-mcp`, `Notification-idle-in-turn`, `Notification-permission-prompt` |
| D | headless, `--continue` | возобновление сессии C | `SessionStart-resume` |
| E | TUI | `/quit` | `SessionEnd` |

## Ответы на вопросы задачи 1.3

**(а) Синтаксис matcher.** Это не глоб. Qwen (`matchesHookPattern`) сравнивает так:
1. Пустой matcher, `*` и `.*` подходят ко всему.
2. Если строка точно совпала с именем инструмента или его алиасом — совпадение.
3. Если matcher содержит `|` и не начинается с `^` или `(`, он делится на альтернативы. Каждая альтернатива сравнивается точно, а потом все вместе склеиваются в регулярное выражение.
4. Иначе это `new RegExp(matcher).test(toolName)`, причём **без якорей**.

Поэтому `edit` подходит и к `notebook_edit`, а такой инструмент в Qwen есть. Matchers расширения пишутся с якорями: `^(write_file|edit)$`, `^mcp__.+$`.

Отложенные MCP-инструменты модель вызывает через мета-инструмент `tool_call`, перед этим обязательно через `tool_search select:<name>`. Но хуки получают **исходное** имя `mcp__<server>__<tool>`, а для самого `tool_call` хуки не запускаются (`PreToolUse-mcp.json`, `PostToolUse-mcp.json`). Значит, `^mcp__.+$` ловит все MCP-вызовы.

**(б) Какое событие приходит при отказе в диалоге.** Ни `PermissionDenied`, ни `PostToolUseFailure`, ни `Stop` не приходят. Варианты в диалоге — «1. Да, разрешить один раз» и «2. Нет, предложить изменения (esc)». Отказ отменяет весь ход. Единственный след — `PostToolBatch`: `tool_calls[i].status = "cancelled"` и ошибка `"[Operation Cancelled] Reason: User did not allow tool call"` (`PostToolBatch-write_file-rejected.json`). Сразу после этого приходит `Notification` с `notification_type: "idle_prompt"` **без** `prompt_id` (`Notification-idle-turn-end.json`).

Важно: `idle_prompt` приходит и посреди хода, пока Qwen ждёт разрешения, но тогда в нём есть `prompt_id` (`Notification-idle-in-turn.json`). Конец хода — это `Stop` либо `idle_prompt` без `prompt_id`.

**(в) Приходит ли `UserPromptExpansion` для файловых команд.** Приходит. Для `.qwen/commands/opsx-propose.md` пришли `command_name: "opsx-propose"`, `command_args: "demo change"` и развёрнутый `prompt` (`UserPromptExpansion-opsx-propose.json`). Первый `UserPromptSubmit` хода содержит `submitted_prompt: "/opsx-propose demo change"`. Следующие `UserPromptSubmit` того же хода (по одному на каждый запрос к модели) приходят без `submitted_prompt` и с пустым `prompt` (`UserPromptSubmit-continuation.json`).

**(г) Показывается ли `systemMessage` из `PostToolUse` в интерактивной ленте.** Не показывается: проверено пробным хуком в прогоне B. `systemMessage` из `Stop` показывается блоком `⎿ Stop says: <текст>`. Выбранный режим D8: сообщения копятся в журнале сессии и выводятся одним блоком на `Stop`. Если ход отменён, `Stop` не приходит. Тогда сообщение об отказе в ленту не попадает, а артефакт помечается `✗` в status line.

## Прочие наблюдения

- `PermissionRequest` приходит **без** `tool_use_id`: есть только `tool_name` и `tool_input`. Связывать его с `PreToolUse` приходится по `tool_name` и `tool_input`. Он приходит и для диалога, вызванного `ask` в режиме `yolo` (`PermissionRequest-write_file-yolo-ask.json`).
- `permissionDecision: "ask"` в режиме `yolo` действительно показывает диалог. Наша причина выводится в диалоге строкой `⚠ <reason>` над диффом, варианта «разрешить всегда» нет.
- Пока открыт диалог подтверждения, футера со status line на экране нет.
- `tool_use_id` в `PreToolUse` и `PostToolUse`/`PostToolUseFailure` совпадает. В `PostToolBatch` это `call_…` (равен `tool_call_id`). `PostToolUse.duration_ms` — время выполнения.
- Фоновые агенты Qwen (например, автопамять) запускают инструменты в той же сессии и с тем же `session_id`, поэтому хуки срабатывают и на их вызовы.
- При `--continue`/`--resume` сохраняется `session_id`, а `SessionStart.source` равен `"resume"` (иначе `"startup"`).
- `Stop` содержит `last_assistant_message`. Расширение это поле не сохраняет.
