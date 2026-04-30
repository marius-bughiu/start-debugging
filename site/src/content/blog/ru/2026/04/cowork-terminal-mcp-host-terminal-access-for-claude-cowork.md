---
title: "cowork-terminal-mcp: доступ к терминалу хоста для Claude Cowork в одном MCP-сервере"
description: "cowork-terminal-mcp v0.4.1 связывает изолированную ВМ Claude Cowork с шеллом вашего хоста. Один инструмент, транспорт stdio, жёстко зафиксированный Git Bash на Windows."
pubDate: 2026-04-29
tags:
  - "mcp"
  - "claude-cowork"
  - "claude-code"
  - "ai-coding-agents"
lang: "ru"
translationOf: "2026/04/cowork-terminal-mcp-host-terminal-access-for-claude-cowork"
translatedBy: "claude"
translationDate: 2026-04-29
---

[Claude Cowork](https://www.anthropic.com/claude-cowork) запускается внутри изолированной Linux-ВМ на вашей машине. Именно эта изоляция делает комфортным запуск Cowork в фоновом режиме без присмотра, но она же означает, что агент не может самостоятельно установить зависимости вашего проекта, выполнить сборку или сделать push коммита в репозиторий на хосте. Без моста агент останавливается на границе файловой системы ВМ. [`cowork-terminal-mcp`](https://github.com/marius-bughiu/cowork-terminal-mcp) v0.4.1 как раз и есть такой мост: узкоспециализированный [MCP](https://modelcontextprotocol.io/)-сервер, который работает на хосте, предоставляет один инструмент (`execute_command`) и на этом останавливается. Всё это около 200 строк TypeScript, поставляется в npm как [`cowork-terminal-mcp`](https://www.npmjs.com/package/cowork-terminal-mcp).

## Единственный инструмент, который предоставляет сервер

`execute_command` -- это вся поверхность сервера. Его Zod-схема находится в [`src/tools/execute-command.ts`](https://github.com/marius-bughiu/cowork-terminal-mcp/blob/main/src/tools/execute-command.ts) и принимает четыре параметра:

| Параметр  | Тип                        | Значение по умолчанию | Описание                                                  |
|-----------|----------------------------|-----------------------|-----------------------------------------------------------|
| `command` | `string`                   | обязательный          | Команда bash для выполнения                               |
| `cwd`     | `string`                   | домашний каталог      | Рабочий каталог (предпочтительнее, чем `cd <path> &&`)    |
| `timeout` | `number`                   | `30000` мс            | Сколько ждать до прерывания выполнения                    |
| `env`     | `Record<string, string>`   | унаследованные        | Дополнительные переменные окружения поверх `process.env`  |

Возвращает JSON-объект с полями `stdout`, `stderr`, `exitCode` и `timedOut`. Вывод ограничен 1MB на поток, при достижении лимита добавляется суффикс `[stdout truncated at 1MB]` (или `stderr`).

Почему один инструмент? Потому что любой запрос вида «покажи список файлов», «запусти тесты» или «что говорит git status» сводится к команде шелла. Второй инструмент стал бы лишь чуть более тонкой обёрткой над тем же `spawn`. Каталог MCP остаётся компактным, модель не выбирает не тот инструмент, а поверхность атаки на хост остаётся тривиальной для аудита.

## Подключение к Claude Cowork

Claude Cowork читает MCP-серверы из конфигурации **Claude Desktop** и пробрасывает их в свою изолированную ВМ. Файл конфигурации находится в одном из трёх мест:

- **Windows (установка из Microsoft Store):** `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
- **Windows (стандартная установка):** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Минимальная конфигурация:

```json
{
  "mcpServers": {
    "cowork-terminal": {
      "command": "npx",
      "args": ["-y", "cowork-terminal-mcp"]
    }
  }
}
```

В Windows оберните команду в `cmd /c`, чтобы `npx` корректно разрешался (Claude Desktop запускает команды через PowerShell-совместимую обвязку, которая не всегда находит npm-shim'ы):

```json
{
  "mcpServers": {
    "cowork-terminal": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "cowork-terminal-mcp"]
    }
  }
}
```

Для пользователей Claude Code CLI тот же сервер служит ещё и запасным выходом к терминалу хоста и регистрируется одной строкой:

```bash
claude mcp add cowork-terminal -- npx -y cowork-terminal-mcp
```

Единственное требование -- bash. На macOS и Linux достаточно системного шелла. На Windows должен быть установлен [Git for Windows](https://git-scm.com/download/win), и сервер придерживается определённой позиции относительно того, какой `bash.exe` он готов принять, -- это и есть следующий интересный момент.

## Ловушка Git Bash на Windows

`spawn("bash")` на Windows выглядит безобидно и почти всегда даёт неверный результат. Порядок PATH в Windows ставит `C:\Windows\System32` ближе к началу, и `System32\bash.exe` присутствует на большинстве современных установок Windows. Это не Git Bash, а лаунчер WSL. Когда MCP-сервер передаёт ему команду, она выполняется внутри Linux-ВМ, которая не видит файловую систему Windows так, как её видит хост, не может прочитать `PATH` Windows и не может выполнять `.exe`-файлы Windows. Видимый симптом получается забавный: `dotnet --version` возвращает «command not found», хотя SDK .NET явно установлен и присутствует в `PATH`. То же самое с `node`, `npm`, `git` и каждой нативной для Windows утилитой, к которой обращается агент.

`cowork-terminal-mcp` исправляет это на старте. `resolveBashPath()` на Windows полностью пропускает поиск по PATH и проходит фиксированный список мест установки Git Bash:

```typescript
const candidates = [
  path.join(programFiles, "Git", "bin", "bash.exe"),
  path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
  path.join(programFilesX86, "Git", "bin", "bash.exe"),
  path.join(programFilesX86, "Git", "usr", "bin", "bash.exe"),
  localAppData && path.join(localAppData, "Programs", "Git", "bin", "bash.exe"),
  localAppData && path.join(localAppData, "Programs", "Git", "usr", "bin", "bash.exe"),
];
```

Побеждает первый кандидат, который подтверждает `existsSync`, и именно с этим разрешённым абсолютным путём вызывается `spawn`. Если ни один не найден, сервер на этапе загрузки модуля бросает исключение с сообщением, в котором перечислены все проверенные пути и указана ссылка `https://git-scm.com/download/win`. Никакого фолбэка на bash из System32 и никакой тихой деградации.

Более широкий вывод: на Windows «доверять PATH» -- выстрел в ногу всякий раз, когда важно поведение конкретного бинарника. Разрешайте по абсолютному пути или громко падайте. Эта правка вышла именно в v0.4.1, потому что пользователи наблюдали, как агент настаивает на отсутствии `dotnet` на машинах, где тот был очевидно установлен.

## Тайм-ауты, ограничения вывода и правило одного шелла

В исполнителе встречаются ещё три решения, и все они продуманные.

**AbortController вместо тайм-аута на уровне шелла.** Когда команда превышает свой `timeout`, сервер не оборачивает вызов bash в `timeout 30s ...`. Он вызывает `abortController.abort()`, что Node.js преобразует в завершение процесса. Дочерний процесс генерирует событие `error`, у которого `name` равен `AbortError`; обработчик очищает таймер, и инструмент резолвится с `exitCode: null` и `timedOut: true`:

```typescript
const timer = setTimeout(() => {
  abortController.abort();
}, options.timeout);

child.on("error", (error) => {
  clearTimeout(timer);
  if (error.name === "AbortError") {
    resolve({ stdout, stderr, exitCode: null, timedOut: true });
  } else {
    reject(error);
  }
});
```

Так механика тайм-аута остаётся вне строки команды пользователя и работает одинаково на Windows и Unix.

**Лимит 1MB на поток, встроенный.** `stdout` и `stderr` накапливаются в строках JavaScript, но каждое событие `data` проверяется условием `length < MAX_OUTPUT_SIZE` (1 048 576 байт). При достижении лимита дополнительные данные отбрасываются и устанавливается флаг. Итоговая строка результата получает суффикс `[stdout truncated at 1MB]`. Это цена буферизации вместо стриминга: модель получает чистый структурированный результат, но `tail -f some.log` -- не та задача, для которой создан этот сервер. Типичный `npm test` или `dotnet build` помещается без проблем.

**Шелл -- это bash, и точка.** В v0.3.0 был параметр `shell`, позволявший модели выбирать `cmd` на Windows. v0.4.0 его удалила. Причина зарыта в [CHANGELOG](https://github.com/marius-bughiu/cowork-terminal-mcp/blob/main/CHANGELOG.md): правила двойных кавычек `cmd.exe` молча обрезают многострочные строки на первом переводе строки, поэтому тела heredoc, которые модель отправляла через `cmd`, схлопывались до первой строки. Модель полагала, что команда отработала с тем телом, которое она составила; bash на другой стороне был с этим не согласен. Убрать выбор оказалось дешевле, чем учить модель всегда выбирать bash. По той же причине описание инструмента (в `src/tools/execute-command.ts`) активно подталкивает модель к heredoc'ам:

```
gh pr create --title "My PR" --body "$(cat <<'EOF'
## Summary

- First item
- Second item
EOF
)"
```

Символы `\n` в JSON-строке `command` декодируются в настоящие переводы строк до того, как их увидит bash, а дальше всё делает heredoc-семантика самого bash.

## Без PTY, по дизайну

Дочерний процесс запускается с `stdio: ["ignore", "pipe", "pipe"]`, без псевдотерминала. Нет способа подключиться к работающему prompt, нет сигнализации ширины терминала, нет согласования цвета по умолчанию. Для команд сборки, установки пакетов, git и запуска тестов этого вполне достаточно; модель получает чистый вывод без ANSI-escape-последовательностей в качестве шума. Для `vim`, `top`, `lldb` или любого REPL, который ожидает интерактивный TTY, этот инструмент не подходит. Сервер и не пытается его имитировать.

Такой компромисс выбран сознательно. MCP-сервер на основе PTY потребовал бы стриминга, протокола частичного вывода и интерактивной семантики ввода-вывода, которую сам MCP сейчас плохо моделирует. `cowork-terminal-mcp` остаётся в той области, где разовая команда действительно укладывается в протокол.

## Когда этот мост -- правильный

`cowork-terminal-mcp` мал намеренно. Один инструмент, только stdio, громко падающее разрешение bash, продуманные ограничения вывода, без выбора шелла, без PTY. Если вы запускаете Claude Cowork на Windows и хотите, чтобы он действительно мог что-то выполнять на хосте, это и есть мост, благодаря которому граница sandbox перестаёт мешать. Если вы уже пользуетесь Claude Code CLI, это дешёвая дополнительная возможность, которую полезно держать зарегистрированной на тот день, когда какой-то workflow выйдет за пределы встроенного инструмента `Bash` модели. Исходный код и issues -- на [github.com/marius-bughiu/cowork-terminal-mcp](https://github.com/marius-bughiu/cowork-terminal-mcp); пакет в npm -- [cowork-terminal-mcp](https://www.npmjs.com/package/cowork-terminal-mcp).
