# Сквозная проверка в Qwen Code

Запуск: `QWEN_BIN=/path/to/qwen npm run e2e` (нужны `python3` и `openspec` в `PATH`).

Скрипт `test/e2e/e2e.mjs` работает во временном каталоге с отдельным `HOME`:
1. проходит README с нуля: `openspec init --tools qwen`, `qwen extensions link`, `setup`;
2. запускает настоящий интерактивный TUI Qwen через pty (`test/harness/tui-driver.py`);
3. вместо модели подключает сценарный OpenAI-совместимый сервер (`test/harness/fake-model.mjs`), MCP-вызовы идут к `test/fixtures/slow-mcp.mjs`;
4. проверяет то, что реально было на экране.

Поведение самой модели (что она спросит после отказа) фейковая модель не воспроизводит. Вместо этого проверяется, что инструкция из `QWEN.md` доходит до модели.

## Последний прогон

2026-10-20, macOS, Qwen Code 0.25.2, OpenSpec 1.13.0 — **26/26**.

| Пункт чеклиста | Режим | Результат |
|---|---|---|
| README: `openspec init --tools qwen`, `qwen extensions link`, расширение в `qwen extensions list` | — | ✅ |
| `setup` не заменяет чужой status line без `--force`; с `--force` ставит свой и сохраняет бэкап | — | ✅ |
| Вне флоу показывается прежний status line пользователя | default | ✅ |
| `/opsx-explore` выделяет explore, «нет активного change» | default | ✅ |
| `/opsx-propose` выделяет propose и показывает change | yolo | ✅ |
| В YOLO запись `proposal` и `design` требует подтверждения, причина называет артефакт и change | yolo | ✅ |
| Артефакт в работе — `◐`, принятый — `✓`; файлы записаны только после одобрения | yolo | ✅ |
| Таймер `⏳ slow›wait Ns` тикает (видели 0…4 s) | yolo | ✅ |
| В конце хода в ленте сводка `✓ opsx: … принят` | yolo | ✅ |
| `--continue` сразу показывает фазу и change | default | ✅ |
| В auto-edit запись `tasks` требует подтверждения; отказ (Esc) даёт `✗`, артефакт больше не «пишется», файл не тронут | auto-edit | ✅ |
| Инструкция «не повторять отклонённую запись» из `QWEN.md` есть в запросе к модели | auto-edit | ✅ |
| `/opsx-apply` показывает `задачи N/M`, отметка задачи в `tasks.md` не вызывает диалога | yolo | ✅ |
| Две параллельные сессии в одном проекте видят каждая свою фазу (explore / propose) | default + yolo | ✅ |
| `setup --remove` возвращает прежний status line, футер снова показывает его | default | ✅ |

Кадры футера из этого прогона:

```
opsx  explore › ● propose › apply › archive   e2e-change
proposal ✓  specs ○  design ○  tasks ·   ⏳ slow›wait 2s

opsx  explore › ● propose › apply › archive   e2e-change
proposal ✓  specs ○  design ◐  tasks ·   пишется design

opsx  explore › ● propose › apply › archive   e2e-change
proposal ✓  specs ○  design ✓  tasks ✗

opsx  explore › propose › ● apply › archive   e2e-change
задачи 1/3
```

Диалог и сводка в ленте:

```
? WriteFile Writing to …/openspec/changes/e2e-change/proposal.md ←
   ⚠ OpenSpec: подтвердите артефакт «proposal» (change e2e-change). Для headless-запусков: OPSX_UI_APPROVAL=off
   › 1. Да, разрешить один раз
     2. Нет, предложить изменения (esc)

◆︎ propose-done
 ⎿ Stop says:
    ✓ opsx: proposal.md принят
    ✓ opsx: design.md принят
```

## Что нашла сквозная проверка и что исправлено

- После отказа отклонённый артефакт оставался «текущим», и футер показывал `tasks ✗   пишется tasks`. Исправлено в редьюсере, добавлен unit-тест, e2e-проверка ужесточена.
- Ошибки самого сценария, не расширения: в auto-edit Qwen спрашивает разрешение на shell-команды; `edit` требует сначала прочитать файл через `read_file`. Сценарий поправлен.
