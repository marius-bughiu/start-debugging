---
title: "Как создать пользовательский MCP-сервер на TypeScript, оборачивающий CLI"
description: "Пошаговое руководство по обёртыванию любого инструмента командной строки в виде сервера Model Context Protocol с использованием TypeScript SDK 1.29. Охватывает ловушку stdout, шаблоны child_process, распространение ошибок и полный рабочий git-сервер."
pubDate: 2026-04-24
tags:
  - "mcp"
  - "ai-agents"
  - "typescript"
  - "claude-code"
lang: "ru"
translationOf: "2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli"
translatedBy: "claude"
translationDate: 2026-04-25
---

Самый быстрый способ дать ИИ-агенту доступ к инструменту командной строки -- обернуть его как сервер Model Context Protocol (MCP). Агент вызывает типизированный инструмент, ваш сервер запускает CLI как подпроцесс, перехватывает вывод и возвращает его в виде структурированного ответа -- без REST API, без привязок SDK, без вебхуков.

Это руководство строит такую обёртку с нуля, используя `@modelcontextprotocol/sdk` 1.29.0 и Node 18+. К концу у вас будет рабочий сервер `git-mcp`, предоставляющий `git log` и `git diff` как вызываемые инструменты, подключённый к Claude Desktop через stdio-транспорт. Каждая ловушка, которая ломает CLI-обёртки в продакшене, рассмотрена.

## Почему "обернуть CLI" -- правильный первый шаг

Большинство внутренних инструментов существует только как CLI: скрипты развёртывания, исполнители миграций баз данных, экспортёры журналов аудита, конвейеры обработки изображений. У них нет API, нет gRPC-поверхности, ничего, что агент мог бы вызвать напрямую. Обёртывание их в виде MCP-инструментов занимает 50-100 строк TypeScript и даёт обнаруживаемый, валидируемый по схеме интерфейс, которым может пользоваться любой MCP-совместимый клиент, включая Claude Code, Claude Desktop, Cursor и любой клиент, говорящий на [спецификации MCP (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26).

Альтернатива -- встраивать вызов CLI внутрь системного запроса или описания инструмента -- хрупка. Аргументы калечатся, обработка ошибок исчезает, и агент не может отличить таймаут от плохого флага. Правильный MCP-сервер исправляет всё это.

## Настройка проекта

Вам нужен Node.js 18 или новее. Создайте директорию проекта и установите зависимости:

```bash
mkdir git-mcp
cd git-mcp
npm init -y
npm install @modelcontextprotocol/sdk@1.29.0 zod@3
npm install -D @types/node typescript
```

Добавьте два поля в `package.json` и скрипт сборки. Поле `"type": "module"` указывает Node трактовать файлы `.js` как модули ES, что требуется SDK:

```json
{
  "type": "module",
  "bin": {
    "git-mcp": "./build/index.js"
  },
  "scripts": {
    "build": "tsc && chmod +x build/index.js"
  },
  "files": ["build"]
}
```

Создайте `tsconfig.json` в корне проекта:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

Создайте исходный файл:

```bash
mkdir src
touch src/index.ts
```

## Ловушка stdout, которая убивает каждый stdio-сервер MCP

Прежде чем написать хоть одну строку бизнес-логики, выгравируйте это правило: **никогда не вызывайте `console.log()` внутри stdio MCP-сервера**.

Когда вы запускаете свой сервер под stdio-транспортом, MCP-клиент общается с ним через `stdin`/`stdout` сообщениями JSON-RPC. Любые байты, которые вы записываете в `stdout` вне протокола JSON-RPC, повреждают поток сообщений. Клиент увидит некорректный JSON, не сможет распарсить ответ и отключится -- обычно с загадочной ошибкой "MCP server disconnected", которая указывает в никуда рядом с вашей невинно выглядящей отладочной командой.

```typescript
// @modelcontextprotocol/sdk 1.29.0, MCP spec 2025-03-26

// Bad -- corrupts the JSON-RPC stream
console.log("Running git log...");

// Good -- stderr is not part of the stdio transport
console.error("Running git log...");
```

Используйте `console.error()` для каждой диагностической строки. Она пишет в `stderr`, который MCP-клиент либо игнорирует, либо отображает отдельно. Это не пограничный случай -- на этом спотыкается почти каждый автор MCP-серверов в первый раз.

## Запуск CLI

Добавьте типизированный помощник, который порождает подпроцесс, собирает stdout и stderr и разрешается со структурированным результатом. Использование `spawn` вместо `exec` обходит ограничение буфера по умолчанию в 1 МБ, которое накладывает `exec`:

```typescript
// src/index.ts
// @modelcontextprotocol/sdk 1.29.0, Node 18+

import { spawn } from "child_process";

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(
  command: string,
  args: string[],
  cwd?: string,
  timeoutMs = 30_000
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const child = spawn(command, args, {
      cwd,
      shell: false, // never pass shell: true with untrusted input
      timeout: timeoutMs,
    });

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}
```

Два момента стоят внимания:

- `shell: false` не опционален, если какая-либо часть аргументов приходит от LLM. С `shell: true` аргумент вроде `--format=%H; rm -rf /` становится shell-инъекцией. Всегда передавайте аргументы как массив и пусть `spawn` обрабатывает экранирование.
- Таймаут распространяется через опцию `timeout` в `child_process` Node, которая отправляет `SIGTERM` после крайнего срока. Добавьте резервный `SIGKILL`, если CLI игнорирует `SIGTERM`.

## Регистрация инструментов

Теперь подключите два инструмента `git`. Первый, `git_log`, возвращает последние N коммитов репозитория. Второй, `git_diff`, возвращает diff незакоммиченных изменений:

```typescript
// src/index.ts (continued)
// @modelcontextprotocol/sdk 1.29.0

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "git-mcp",
  version: "1.0.0",
});

server.registerTool(
  "git_log",
  {
    description:
      "Return the last N commits for a git repository. " +
      "Includes hash, author, date, and subject line.",
    inputSchema: {
      repo: z.string().describe("Absolute path to the git repository root"),
      count: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(20)
        .describe("Number of commits to return"),
    },
  },
  async ({ repo, count }) => {
    const result = await runCli(
      "git",
      ["log", `--max-count=${count}`, "--pretty=format:%H|%an|%ad|%s", "--date=iso"],
      repo
    );

    if (result.exitCode !== 0) {
      return {
        content: [
          {
            type: "text",
            text: `git log failed (exit ${result.exitCode}):\n${result.stderr}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: result.stdout || "(no commits)" }],
    };
  }
);

server.registerTool(
  "git_diff",
  {
    description:
      "Return the unstaged diff for a git repository, or the diff for a specific file.",
    inputSchema: {
      repo: z.string().describe("Absolute path to the git repository root"),
      file: z
        .string()
        .optional()
        .describe("Optional relative path to a specific file"),
      staged: z
        .boolean()
        .default(false)
        .describe("If true, show staged (cached) diff instead of unstaged"),
    },
  },
  async ({ repo, file, staged }) => {
    const args = ["diff"];
    if (staged) args.push("--cached");
    if (file) args.push("--", file);

    const result = await runCli("git", args, repo);

    if (result.exitCode !== 0) {
      return {
        content: [
          {
            type: "text",
            text: `git diff failed (exit ${result.exitCode}):\n${result.stderr}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text", text: result.stdout || "(no changes)" },
      ],
    };
  }
);
```

Несколько вещей, на которые стоит обратить внимание в обработчиках инструментов:

- `inputSchema` использует Zod-схемы напрямую. SDK конвертирует их в JSON Schema для валидации вызовов инструментов клиентом. Если вы передадите простой объект JSON Schema, вы потеряете семантику `.default()` и `.optional()`.
- Возвращайте `isError: true` вместе с содержимым, когда CLI завершается с ненулевым кодом. Это сообщает клиенту, что вызов провалился, не выбрасывая исключение, которое уронит сервер.
- Сохраняйте параметр `repo` как абсолютный путь, который должен предоставить клиент. Не пытайтесь вычислить его из `process.cwd()` -- рабочая директория сервера там, где её запустил MCP-клиент, что почти никогда не репозиторий пользователя.

## Подключение транспорта и запуск сервера

Добавьте главную точку входа в конец `src/index.ts`:

```typescript
// src/index.ts (continued)
// @modelcontextprotocol/sdk 1.29.0, stdio transport

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("git-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
```

Соберите и проверьте, что компилируется:

```bash
npm run build
```

## Подключение к Claude Desktop

Откройте конфиг Claude Desktop. На macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`. На Windows: `%AppData%\Claude\claude_desktop_config.json`.

Добавьте свой сервер под `mcpServers`:

```json
{
  "mcpServers": {
    "git-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/git-mcp/build/index.js"]
    }
  }
}
```

Перезапустите Claude Desktop. Иконка молотка в панели инструментов должна появиться, показывая `git_log` и `git_diff` как доступные инструменты. Теперь вы можете спросить Claude: "Покажи мне последние 10 коммитов в /Users/me/projects/myrepo", и он вызовет `git_log` напрямую.

Чтобы подключить к Claude Code, добавьте тот же блок в свои настройки MCP в Claude Code (`.claude/settings.json` под `mcpServers`), или выполните `claude mcp add git-mcp -- node /path/to/build/index.js` из терминала.

## Ловушки в продакшен-обёртках CLI

**Усечение большого вывода.** Некоторые CLI выдают мегабайты вывода (`git diff` на большом рефакторинге, `ps aux`, полный SQL-дамп). Спецификация MCP не навязывает жёсткий лимит размера контента, но у клиентов есть практические лимиты. Добавьте защиту `maxBytes` в `runCli` и возвращайте уведомление об усечении:

```typescript
const MAX_BYTES = 512_000; // 500 KB

// after collecting chunks:
const raw = Buffer.concat(chunks);
const text =
  raw.byteLength > MAX_BYTES
    ? raw.slice(0, MAX_BYTES).toString("utf8") + "\n\n[output truncated]"
    : raw.toString("utf8");
```

**Поиск PATH в Windows.** На Windows `spawn("git", ...)` с `shell: false` может не сработать, если `git` не в PATH, который наследует MCP-клиент. Либо используйте полный путь к исполняемому файлу, либо запускайте обёртку `cmd.exe /c git ...` (с правильной санитизацией аргументов). Альтернативно, разрешите путь к исполняемому файлу при старте, используя npm-пакет `which`, и закешируйте результат.

**Таймаут на медленных операциях.** `git log` на репозитории с 500 000 коммитов может занять несколько секунд. Настраивайте `timeoutMs` для каждого инструмента, а не используйте глобальное значение по умолчанию. Выставьте его как опциональный параметр, если размер репозитория пользователя непредсказуем.

**Сообщения об ошибках из stderr.** Многие CLI пишут ошибки использования в stderr с кодом выхода 0 (известная плохая привычка). Проверяйте `result.stderr` даже когда `exitCode === 0`, и выводите его в ответе инструмента вместе с содержимым stdout.

**Нет shell-globbing.** С `shell: false` глобы вроде `*.ts` в аргументе не раскрываются shell. Если ваш CLI ожидает раскрытия глобов, либо перечисляйте файлы сами (используя `glob` из npm), либо принимайте только явные пути в схеме инструмента.

## Тестирование без клиента

Установите `@modelcontextprotocol/inspector` глобально, чтобы тестировать сервер интерактивно без настройки полного MCP-клиента:

```bash
npm install -g @modelcontextprotocol/inspector
npx @modelcontextprotocol/inspector node build/index.js
```

Inspector открывает UI в браузере, где вы можете перечислять инструменты, заполнять аргументы и вызывать их напрямую. Он также показывает сырые JSON-RPC сообщения, что делает диагностику проблемы повреждения stdout тривиальной -- вы можете видеть мусорные байты, попадающие в поток, мгновенно.

## Что выставить дальше

Два инструмента -- это тонкий срез. Тот же шаблон масштабируется на любой CLI, на который опирается ваша команда:

- Выставьте `git blame`, `git show` и `git grep`, чтобы построить агента кодовой археологии.
- Оберните `aws s3 ls` и `aws cloudformation describe-stacks` для агента, осведомлённого об инфраструктуре.
- Выставьте `sqlite3 :memory: .schema` или `psql \d tablename`, чтобы агент мог исследовать схему базы данных перед написанием запросов.
- Оберните пользовательский внутренний CLI для развёртывания, создания тикетов или экспорта журналов -- вещи, которые жили только в shell-скриптах, потому что "никому не нужно было API для них."

MCP-серверу всё равно, что делает CLI. Ему нужна только хорошо определённая входная схема (которую Zod даёт вам в 3 строках) и обработчик, который запускает бинарник и возвращает вывод.

Если ваша команда использует C# вместо TypeScript, тот же шаблон доступен через [пакет NuGet ModelContextProtocol, который мы рассматривали при подключении MCP-серверов на .NET 10](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/). Для более широкого взгляда на то, как MCP выглядит, когда IDE поставляет его напрямую, [Azure MCP Server, поставляемый внутри Visual Studio 2022 17.14.30](/ru/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/), -- полезный реальный пример масштаба, на который нацелен этот протокол. И если вы строите автономных агентов, координирующих несколько инструментов, и нуждаетесь в фреймворке поверх сырого MCP, [Microsoft Agent Framework 1.0](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) покрывает сторону C#. А для интеграции агентов на уровне IDE, [agent skills в Visual Studio 2026 18.5](/ru/2026/04/visual-studio-2026-copilot-agent-skills/) показывают, как Copilot автоматически обнаруживает определения skills из `SKILL.md` вашего репозитория.

## Источники

- [MCP TypeScript SDK -- modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP spec (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26)
- [Official build-server guide -- modelcontextprotocol.io](https://modelcontextprotocol.io/docs/develop/build-server)
- [MCP Inspector -- @modelcontextprotocol/inspector](https://github.com/modelcontextprotocol/inspector)
