## Context

Мотивация — в `proposal.md` (раздел Why), требования — в `specs/qwen-opsx-ui/*`. Ниже только то, что определяет подход.

Ограничения, проверенные по установленному `@qwen-code/qwen-code@0.25.2`:

- **Нет API панелей для расширений.** Расширение (`qwen-extension.json`) может дать хуки, команды, скиллы, агентов, MCP-серверы, контекст, каналы и LSP. Отрисовывать свои компоненты Ink оно не может.
- **Qwen-«моды» (`experimental.mods`) не подходят.** `ModSession.allowed()` требует `!config.isInteractive()`, а команды модов объявлены с `supportedModes: ["non_interactive"]`. В интерактивной сессии они не работают.
- **Status line.** `ui.statusLine` типа `command`: Qwen передаёт команде на stdin JSON (`session_id`, `workspace.current_dir`, `model.display_name`, `context_window.*`, `git.branch`, `metrics`). Рендерится максимум 2 строки (`MAX_STATUS_LINES=2`), таймаут команды 5 с, `refreshInterval` от 1 с, с `respectUserColors: true` ANSI-цвета сохраняются. Расширение не может прописать status line само: это поле пользовательских или проектных настроек.
- **Хуки.** Набор событий как в Claude-хуках: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `UserPromptSubmit`, `UserPromptExpansion` (`command_name`, `command_args`), `Stop`, `SessionStart`, `SessionEnd` и др. Базовый вход: `session_id`, `cwd`, `hook_event_name`, `timestamp`. Пара `PreToolUse` → `PostToolUse` связывается через общий `tool_use_id`. MCP-инструменты называются `mcp__<server>__<tool>`. Встроенные инструменты: `write_file`, `edit`, `run_shell_command`, `skill`, `ask_user_question`.
- **Принудительный диалог.** Если `PreToolUse` вернул `hookSpecificOutput.permissionDecision: "ask"`, у вызова появляется флаг `preToolUseAsk`. Этот флаг отключает все ветки автоодобрения (`yolo`, `auto-edit`, `auto`), и Qwen показывает нативный диалог. В неинтерактивном режиме `canPromptForPreToolUseAsk()` возвращает `false`, и вызов блокируется с нашей причиной. Падение самого хука Qwen трактует как разрешение (`hookError → shouldProceed: true`).
- **OpenSpec.** `openspec init --tools qwen` создаёт `.qwen/commands/opsx-{explore,propose,apply,archive,update,sync}.md` и `.qwen/skills/openspec-*/SKILL.md`. Команда `openspec status --json` даёт `artifacts[].status/requires`, `artifactPaths`, `changeRoot` и отрабатывает за ~330 мс. Старт Node — ~60 мс.

## Goals / Non-Goals

**Goals:**
- Один процесс Node на событие и на тик status line. Никаких фоновых демонов, сокетов и сети.
- Ноль рантайм-зависимостей и ноль шагов сборки: расширение работает сразу после `qwen extensions link`.
- Логика (редьюсер состояния, классификация путей, разбор shell-команд, рендер) — чистые функции, которые тестируются без Qwen.

**Non-Goals:**
- Свои панели, кнопки и ввод внутри TUI Qwen. Подтверждение идёт только через нативный диалог.
- Отдельный трекинг субагентов и вызовов через инструмент `exec` (code mode). Их записи файлов проходят через тот же гейт, только если они вызывают `write_file`/`edit`/`run_shell_command`.
- Поддержка Windows. Пути пишутся кроссплатформенно, но проверяются только на macOS/Linux.
- Изменение OpenSpec-скиллов и команд, которые генерирует `openspec init`.

## Decisions

### D1. Поверхность UI: status line + хуки + нативный диалог
Состояние собирают хуки расширения, рисует его command status line. Подтверждение идёт через `permissionDecision: "ask"`.
- *Альтернатива: форк/патч Ink-UI Qwen.* Богаче, но бандл нельзя расширить штатно, и патч ломается на каждом релизе.
- *Альтернатива: панель-компаньон (tmux/второй терминал).* Её можно добавить позже поверх того же журнала событий (D3), но живёт она вне сессии. Пользователь выбрал вариант «нативно в сессии».
- *Альтернатива: MCP-сервер расширения.* Он не видит вызовы других инструментов и MCP, а для гейта всё равно нужны хуки.
- *Альтернатива: Qwen-моды.* Не работают в интерактивном режиме (см. Context).

### D2. Один исполняемый файл с подкомандами, чистый ESM без сборки
`bin/opsx-ui.mjs` разбирает подкоманду и делегирует в `src/`:
- `hook <EventName>` — читает JSON со stdin, пишет JSON-ответ хука в stdout;
- `statusline [--scope project|user]` — рендер;
- `setup [--user] [--force] [--remove]` — установка status line.

Код — `.mjs` с JSDoc-типами и `// @ts-check`, тесты — `node --test`.
- *Альтернатива: TypeScript со сборкой в `dist/`.* Это шаг сборки при установке и риск устаревшего `dist`. Выигрыш для ~1–2 тыс. строк небольшой.

Раскладка:
```
qwen-extension.json   QWEN.md   bin/opsx-ui.mjs
src/config.mjs                  env + .qwen/opsx-ui.json + ~/.qwen/opsx-ui/config.json
src/state/log.mjs               append/read/compact JSONL
src/state/reducer.mjs           events → SessionState (чистая функция)
src/hooks/index.mjs             hook payload → domain events (+ решение гейта)
src/openspec/shell.mjs          разбор openspec-вызовов и shell-записей в файлы
src/openspec/status.mjs         кеш `openspec status --json`, сопоставление путей с артефактами
src/gate.mjs                    классификация пути + режим → ask | none
src/statusline/render.mjs       SessionState + ArtifactStatus → ≤2 строки
src/setup.mjs                   слияние ui.statusLine, бэкап/восстановление
test/**                         unit + интеграция через spawn с фикстурами payload
```

### D3. Состояние — журнал событий сессии (JSONL) + чистый редьюсер
Каждый хук дописывает одну строку-событие в `~/.qwen/opsx-ui/sessions/<session_id>.jsonl` одним `appendFileSync` (O_APPEND, строка < 4 КБ). Status line читает журнал и сворачивает его редьюсером в `SessionState { phase, change, currentArtifact, artifactMarks{id→approved|rejected|awaiting}, pendingTools{tool_use_id→{kind, server, tool, startedAt, awaitingApproval}} }`.

Доменные события: `phase`, `change`, `artifact.current`, `artifact.awaiting`, `artifact.approved`, `artifact.rejected`, `mcp.start`, `mcp.awaiting`, `mcp.end`, `turn.stop`, `session.start`, `session.end`.
- *Почему:* Qwen выполняет вызовы инструментов параллельно, и хуки пишут одновременно. Дозапись строк атомарна без блокировок, а «прочитать-изменить-записать» общий JSON дало бы гонки и потерю событий. Журнал заодно служит отладкой и переживает `--resume` (тот же `session_id`).
- *Компакция:* на `SessionStart` (в том числе при resume) и при длине больше 500 строк журнал заменяется одной строкой `snapshot` (запись во временный файл + `rename`). Там же удаляются журналы старше 7 дней.
- *Приватность:* в событиях только идентификаторы, пути внутри `openspec/`, имена серверов и инструментов, время. Хуки не копируют `tool_input` и `prompt` целиком.
- Каталог переопределяется `OPSX_UI_HOME` (для тестов).

### D4. Сопоставление хуков с событиями
| Хук (matcher) | Что извлекаем |
|---|---|
| `UserPromptExpansion` (`opsx-.*`) | `command_name` → `phase` (`opsx-update` → `update` и т. д.) |
| `UserPromptSubmit` с `submitted_prompt` | начало хода пользователя: `turn.stop` для хвостов прошлого хода; запасной путь для фазы, если `submitted_prompt` начинается с `/opsx-<фаза>`. Продолжения хода приходят без `submitted_prompt` и игнорируются |
| `PreToolUse` (`skill`) | имя скилла `openspec-*` → `phase` |
| `PreToolUse` (`run_shell_command`) | `openspec new change "<n>"`, `--change "<n>"` → `change`; `openspec instructions <id>` → `artifact.current`; запись в артефакт → гейт (D5) |
| `PreToolUse` (`write_file\|edit`) | путь в `openspec/changes/<n>/` → `change`, `artifact.current`, гейт (D5) |
| `PreToolUse` (`mcp__.*`) | `mcp.start {server, tool, tool_use_id}` (отложенные MCP-инструменты, вызванные через `tool_call`, приходят в хук под исходным именем) |
| `PermissionRequest` | `mcp.awaiting` / `artifact.awaiting`. В payload нет `tool_use_id`, поэтому сопоставление идёт по `tool_name` + `tool_input` с последним незавершённым `PreToolUse` |
| `PostToolUse`, `PostToolUseFailure` (те же matchers) | `mcp.end {duration_ms}`; для одобренной записи артефакта — `artifact.approved` + сообщение в очередь (D8) |
| `PostToolBatch` | вызов со `status: "cancelled"` (отказ в диалоге отменяет ход) → `artifact.rejected` / `mcp.end` |
| `PermissionDenied` | запасной путь для отказов по правилам доступа: `artifact.rejected` / `mcp.end` (при отказе в диалоге Qwen его не присылает) |
| `Stop`; `Notification` `idle_prompt` без `prompt_id` | `turn.stop`: снять все ожидающие вызовы и подтверждения. `Stop` дополнительно выдаёт накопленные сообщения (D8). После отмены хода `Stop` не приходит, но приходит `idle_prompt` без `prompt_id` |
| `SessionStart` | компакция, очистка, одноразовая подсказка об установке |
| `SessionEnd` | `session.end` |

Разбор shell — консервативный токенайзер: кавычки, `&&`/`;`/`|`. Распознаются только вызовы `openspec …`, перенаправления `>`/`>>`, `tee`, `cp`, `mv`. Всё нераспознанное игнорируется, гейт по догадкам не включается.

### D5. Гейт подтверждения: сначала чистая классификация пути, при сомнении — ask
1. Путь нормализуется относительно `cwd` хука. OpenSpec-корень ищется вверх по дереву (каталог с `openspec/`). Кандидат — `openspec/changes/<name>/<rel>`, где `<name> ≠ archive` и `<rel>` не начинается с точки. Это строковая логика без запуска процессов.
2. Идентификатор артефакта: `<rel>` сопоставляется с `artifactPaths[*].outputPath` (глоб) из кеша `openspec status` (D6). Если кеша нет, используются пути `spec-driven`. Если кандидат не сопоставился ни с чем — гейта нет.
3. Режим: `OPSX_UI_APPROVAL` → `approval` в `.qwen/opsx-ui.json` → `all`. Для `create` гейт срабатывает, только если файла ещё нет. В фазе `apply` правки артефакта `tasks` гейта не требуют.
4. Ответ: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"OpenSpec: подтвердите артефакт «design» (change add-auth). Для headless-запусков: OPSX_UI_APPROVAL=off"}}`.
5. Ошибка в шагах 2–3 для пути-кандидата → всё равно `ask`. Отказ от гейта по ошибке был бы тихим обходом.
- *Альтернатива: мягкий гейт через `ask_user_question`.* Зависит от послушности модели. Пользователь выбрал жёсткий гейт.
- *Альтернатива: `deny` + просьба к агенту спросить пользователя.* Хуже UX: пропадает нативный дифф.

### D6. Кеш статуса OpenSpec и бюджет status line
Status line на каждом тике (раз в секунду):
1. читает stdin;
2. сворачивает журнал;
3. если фазы нет — запасной вывод (D7);
4. считает отпечаток каталога change: число файлов + max `mtimeMs`, рекурсивно, ~десятки `stat`;
5. если отпечаток и change совпадают с кешем `~/.qwen/opsx-ui/cache/<sha1(changeRoot)>.json` — берёт кеш, иначе запускает `openspec status --change <n> --json` (`execFile`, таймаут 800 мс);
6. рендерит.

После ошибки или таймаута CLI повторный запуск идёт не чаще раза в 5 с, а в UI стоит «статус недоступен». Хук гейта читает тот же кеш и `openspec` не запускает, чтобы не задерживать вызов.

Прогресс задач в `apply` — подсчёт `- [x]`/`- [ ]` в `tasks.md`.

### D7. Рендер
Символы статусов: `✓` готов, `◐` в работе, `⚠` ждёт подтверждения, `✗` отклонён, `○` можно начинать, `·` заблокирован, `–` пропущен.

Цвета — базовые ANSI (зелёный, жёлтый, красный, dim). `NO_COLOR` их отключает, символы остаются.

```
opsx  explore › ● propose › apply › archive   add-qwen-opsx-ui
proposal ✓  specs ✓  design ◐  tasks ·      ⏳ context7›get-library-docs 8s +1
```

С ожиданием подтверждения:
```
opsx  explore › ● propose › apply › archive   add-qwen-opsx-ui
proposal ✓  specs ✓  design ⚠  tasks ·      ⚠ подтвердите design в диалоге
```

Ширина: `OPSX_UI_WIDTH` → `width` → 100 символов, длина считается по кодпоинтам. Порядок сокращения по спеке: сначала имя change, затем подписи шагов.

Вне флоу — вывод прежней команды из бэкапа (запускается с тем же stdin, таймаут 2 с) или своя строка `проект · ветка · модель · ctx 23%`.

### D8. Сообщения в ленте
Проверка в Qwen 0.25.2 (`test/fixtures/README.md`, вопрос (г)) показала: `systemMessage` из `PostToolUse` в интерактивной ленте не выводится, а из `Stop` выводится блоком `⎿ Stop says: …`.

Поэтому milestone-сообщения (`✓ opsx: design.md принят`) складываются в журнал сессии событием `notice`. Хук `Stop` выдаёт все невыданные одним `systemMessage` и помечает их выданными (`notice.flushed`).

Когда ход отменён отказом, `Stop` не приходит. Тогда сообщение об отказе в ленту не попадает, а отказ виден как `✗` в status line.

### D9. Установка status line
`setup` пишет `ui.statusLine = { type: "command", command: "node \"<abs>/bin/opsx-ui.mjs\" statusline --scope <scope>", refreshInterval: 1, respectUserColors: true }`. `<abs>` берётся из `import.meta.url`, поэтому работает и для `link`, и для `install`.

Наш статус узнаётся по подстроке `opsx-ui.mjs statusline`, на этом построена идемпотентность. Прежнее значение сохраняется в `.qwen/opsx-ui.json` (проект) или `~/.qwen/opsx-ui/config.json` (`--user`) под ключом `previousStatusLine`, а `--remove` его восстанавливает.

Если `settings.json` содержит комментарии (JSONC), `setup` файл не трогает и печатает фрагмент для ручной вставки. Иначе файл переписывается через `JSON.parse`/`stringify` с отступом 2, порядок ключей сохраняется.

Подсказка об установке: Qwen 0.25 берёт из `SessionStart` только `additionalContext` (проверено по бандлу и пробным хуком), поэтому `SessionStart` ставит подсказку в очередь сообщений (D8), а первый `Stop` её выводит. Флаг «подсказка показана» ставится при выводе и хранится в `~/.qwen/opsx-ui/state.json` по пути проекта, а не в репозитории.

### D10. Манифест и контекст
Хуки объявлены inline в `qwen-extension.json`, команды вида `node "${extensionPath}${/}bin${/}opsx-ui.mjs" hook <Event>` с таймаутом 5 с. Matchers сужены до инструментов из D4 и заякорены (`^(write_file|edit|run_shell_command|skill)$`, `^mcp__.+$`): без якорей Qwen ищет подстроку, и `edit` совпал бы с `notebook_edit`. `settings` и `mcpServers` не объявлены.

`QWEN.md` — до ~10 строк для агента:
- артефакты писать через `write_file`/`edit`, а не через shell;
- после отклонения спросить пользователя через `ask_user_question`, что изменить;
- не пытаться обойти подтверждение.

## Risks / Trade-offs

- [Хуки Qwen — молодой API, формат payload может меняться между 0.25.x] → Фикстуры payload снимаются с реального Qwen 0.25.2 (задача в tasks). Разбор входа терпим к отсутствующим полям. Минимальная версия указывается в README и проверяется в `setup`.
- [Падение хука = разрешение в Qwen, то есть гейт fail-open на уровне платформы] → Путь гейта короткий и без внешних процессов. Внутренние ошибки для кандидатов дают `ask` (D5.5). Классификатор покрыт unit-тестами.
- [Запись артефакта через shell или интерпретатор (`python -c …`) обходит распознавание] → Гейт по shell — best effort для типовых форм. `QWEN.md` требует `write_file`/`edit`. Ограничение задокументировано.
- [`systemMessage` не-`Stop` хуков не показывается в интерактивной ленте (проверено)] → Сводка выводится на `Stop` (D8). Статус и так виден в status line.
- [Пока открыт диалог подтверждения, футер не виден (проверено)] → Причина в самом диалоге называет артефакт и change.
- [При отказе в диалоге не приходят ни `PermissionDenied`, ни `Stop` (проверено)] → Отказ распознаётся по `PostToolBatch` со `status: "cancelled"`. Конец хода распознаётся по `idle_prompt` без `prompt_id` и по следующему `UserPromptSubmit` с `submitted_prompt` (D4).
- [Фоновые агенты Qwen (автопамять и т. п.) вызывают инструменты с тем же `session_id`] → Трекинг и гейт смотрят только на пути внутри `openspec/` и на `mcp__*`. Записи фоновых агентов в свои каталоги на UI не влияют.
- [Задержка: ~60 мс на каждый подходящий вызов инструмента] → Узкие matchers. Без запуска `openspec` в хуках. Только синхронный дешёвый I/O.
- [Время в «⏳ MCP» включает ожидание разрешения до одобрения] → Пока показан диалог, вызов помечается «ждёт подтверждения» (`PermissionRequest`). Время после одобрения считается от начала вызова.
- [Пользовательский status line заменяется] → Без `--force` не трогаем. С `--force` сохраняем бэкап и вызываем прежнюю команду вне флоу. `--remove` всё возвращает.

## Migration Plan

Миграции нет, проект новый. Порядок выката:
1. `qwen extensions link <repo>` и перезапуск Qwen;
2. `node <repo>/bin/opsx-ui.mjs setup` в OpenSpec-проекте (или `--user`);
3. проверка по ручному сценарию из tasks.

Откат: `opsx-ui setup --remove` и `qwen extensions disable qwen-opsx-ui` (или `uninstall`). Журналы в `~/.qwen/opsx-ui/` можно удалить без последствий.

## Open Questions

- Финальная палитра символов и цветов. Её можно подстроить после первых сессий, спеки не меняются.
- Нужна ли отдельная пометка активных субагентов в строке 2. Добавляется отдельным change при необходимости.
