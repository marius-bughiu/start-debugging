---
title: "Как добавить prompt caching в приложение на Anthropic SDK и измерить долю попаданий в кеш"
description: "Добавьте prompt caching в приложение на Python или TypeScript с Anthropic SDK, правильно расставьте точки cache_control и читайте cache_read_input_tokens и cache_creation_input_tokens, чтобы посчитать реальную долю попаданий в кеш. С расчётом цены для Claude Sonnet 4.6 и Opus 4.7."
pubDate: 2026-04-29
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "prompt-caching"
  - "claude-code"
lang: "ru"
translationOf: "2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate"
translatedBy: "claude"
translationDate: 2026-04-29
---

Если ваше приложение на Anthropic SDK на каждом ходу шлёт один и тот же длинный system prompt или каталог инструментов, вы платите полную цену за input для токенов, которые модель уже видела тридцать секунд назад. Prompt caching снижает стоимость этих повторяющихся токенов до **10 процентов от базовой цены input** в обмен на небольшую разовую надбавку за запись. На многоходовом цикле агента с system prompt в 10k токенов это означает снижение стоимости input в 5-10 раз и около 85ms сэкономленной задержки на закешированном префиксе. Подвох: точки cache_control нужно расставлять в правильных местах и проверять долю попаданий по объекту usage из SDK, потому что неудачно поставленная точка тихо деградирует до вызова по полной цене.

Это руководство шаг за шагом разбирает, как добавить кеширование в приложение на Python или TypeScript с Anthropic SDK на текущем API (Claude Opus 4.7, Sonnet 4.6, Haiku 4.5), и затем измерить реальную долю попаданий с помощью небольшой обёртки. Код проверен против `anthropic` 0.42 (Python) и `@anthropic-ai/sdk` 0.30 (Node), оба выпущены в начале 2026 года.

## Почему кеширование не опционально для циклов агента

Агент кодинга, итерирующийся по репозиторию, обычно отправляет:

1. System prompt от 5k до 30k токенов (инструкции агента, описания инструментов, файловые соглашения).
2. Растущую историю сообщений (запрос пользователя плюс предыдущие вызовы инструментов и их результаты).
3. Новый ход пользователя или результат инструмента, запускающий следующий ответ.

Без кеширования каждый ход заново кодирует весь префикс. На Claude Sonnet 4.6 при $3/MTok input, префикс в 8k токенов стоит $0.024 за ход. Сессия в 50 ходов это $1.20 только за повторно тарифицируемый префикс, не считая собственно работы. С кешированием тот же префикс стоит $0.0024 за каждый закешированный ход после первой записи. Тот же ответ, десять процентов счёта.

Механизм описан в [официальной документации по prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching). Вы помечаете блок контента `cache_control: {"type": "ephemeral"}`, и API трактует всё, что находится **до и включая** этот блок, как ключ кеша. На следующем запросе, если префикс совпадает байт в байт, модель читает из кеша вместо повторного кодирования.

Что именно значит "байт в байт", это источник каждой ветки на форумах Anthropic с заголовком "почему не кешируется". Мы до этого ещё дойдём.

## Версии, ID моделей и ловушка минимума токенов

Кеширование срабатывает только когда закешированный префикс превышает минимум, определённый для каждой модели:

- **Claude Opus 4.7 (`claude-opus-4-7`)**: минимум 4 096 токенов.
- **Claude Sonnet 4.6 (`claude-sonnet-4-6`)**: минимум 2 048 токенов.
- **Claude Haiku 4.5 (`claude-haiku-4-5`)**: минимум 4 096 токенов.
- **Старые Sonnet 4.5, Opus 4.1, Sonnet 3.7**: минимум 1 024 токена.

Если ваш префикс меньше порога, запрос всё равно успешен, но `cache_creation_input_tokens` возвращается как 0, и вы тихо платите полную цену input. Это самая частая причина, по которой разработчики жалуются "кеширование ничего не делает". Всегда сначала проверяйте порог для своей целевой модели.

Python SDK `anthropic` получил нативную поддержку `cache_control` в 0.40 и подтянул типизацию для разбивки usage в 0.42. Node SDK имеет это с `@anthropic-ai/sdk` 0.27. Никакой beta header больше не нужен ни для 5-минутного, ни для 1-часового TTL: достаточно задать `ttl` внутри `cache_control`.

## Минимальный пример на Python с cache_control

Шаблон ниже кеширует длинный system prompt. Это самый простой и распространённый случай.

```python
# Python 3.11, anthropic 0.42
import anthropic

client = anthropic.Anthropic()

LONG_SYSTEM_PROMPT = open("prompts/system.md").read()  # ~8k tokens

def ask(user_message: str) -> anthropic.types.Message:
    return client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        system=[
            {
                "type": "text",
                "text": LONG_SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_message}],
    )

first = ask("List the public methods on OrderService.")
second = ask("Now list the private ones.")

print(first.usage)
print(second.usage)
```

Параметр `system` должен быть **массивом блоков контента**, когда вы прикрепляете `cache_control`. Передача обычной строки (удобная форма) не позволяет кешировать: SDK негде поставить флаг кеша. На этом спотыкаются все при первом разе.

Первый вызов записывает префикс в кеш. Второй вызов его читает. Объекты usage делают это видимым:

```
# first.usage
{ "cache_creation_input_tokens": 8137, "cache_read_input_tokens": 0,  "input_tokens": 18,  "output_tokens": 124 }
# second.usage
{ "cache_creation_input_tokens": 0,    "cache_read_input_tokens": 8137, "input_tokens": 22, "output_tokens": 156 }
```

Поля, которые вас интересуют:

- `cache_creation_input_tokens`: токены, записанные в кеш при этом запросе, тарифицируются по 1.25x базы для 5-минутного TTL или 2.0x для 1-часового TTL.
- `cache_read_input_tokens`: токены, прочитанные из кеша, тарифицируются по 0.10x базы.
- `input_tokens`: токены **после последней точки кеша**, не подходящие для кеширования. Это хвост сообщения, который вы постоянно меняете.

## Тот же пример на TypeScript

Node SDK имеет ту же форму. Обратите внимание, что записи массива `system` используют обычные литералы объектов, а не классы-обёртки.

```typescript
// Node 22, @anthropic-ai/sdk 0.30
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";

const client = new Anthropic();
const SYSTEM = readFileSync("prompts/system.md", "utf8");

async function ask(userMessage: string) {
  return client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
  });
}

const first = await ask("List the public methods on OrderService.");
const second = await ask("Now list the private ones.");
console.log(first.usage);
console.log(second.usage);
```

Та же разбивка usage, те же цены. Никакой акробатики с заголовками.

## Куда ставить точки кеша в цикле агента

У агента кодинга не только длинный system prompt. У него длинная **и растущая** история сообщений плюс статический каталог инструментов. Оптимум обычно три или четыре точки, расставленные от самого стабильного к самому волатильному.

У вас до **4 явных точек кеша** на запрос. API кеширует всё до и включая каждый помеченный блок, поэтому каждая точка создаёт префикс послойно.

```python
# Python 3.11, anthropic 0.42
client.messages.create(
    model="claude-opus-4-7",
    max_tokens=2048,
    tools=[
        # ... tool schemas ...
        {
            "name": "search_repo",
            "description": "...",
            "input_schema": {"type": "object", "properties": {...}},
            "cache_control": {"type": "ephemeral"},  # breakpoint 1: tools
        },
    ],
    system=[
        {
            "type": "text",
            "text": SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},  # breakpoint 2: system
        }
    ],
    messages=[
        # All prior turns...
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": stable_repo_summary,
                    "cache_control": {"type": "ephemeral"},  # breakpoint 3: repo state
                }
            ],
        },
        # ... older messages ...
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": current_user_turn,
                    "cache_control": {"type": "ephemeral"},  # breakpoint 4: most recent stable point
                }
            ],
        },
    ],
)
```

Правило такое: "стабильное снаружи, волатильное внутри". Если ваш каталог инструментов меняется при переключении feature flag, это изменение инвалидирует все слои за ним. Если ваш system prompt вшивает сегодняшнюю дату, каждая запись кеша истекает в полночь UTC. Вытащите всё динамическое из кешируемых блоков.

## Измерение доли попаданий

Дашборд провайдера годится для месячного счёта. Он не годится для тонкой настройки агента в реальном времени. Оберните SDK и агрегируйте поля usage сами.

```python
# Python 3.11, anthropic 0.42
from dataclasses import dataclass, field
import anthropic

@dataclass
class CacheStats:
    requests: int = 0
    base_input: int = 0          # uncached
    cache_writes_5m: int = 0
    cache_writes_1h: int = 0
    cache_reads: int = 0
    output: int = 0

    def record(self, usage):
        self.requests += 1
        self.base_input += usage.input_tokens
        self.cache_reads += usage.cache_read_input_tokens or 0
        creation = getattr(usage, "cache_creation", None)
        if creation:
            self.cache_writes_5m += creation.ephemeral_5m_input_tokens or 0
            self.cache_writes_1h += creation.ephemeral_1h_input_tokens or 0
        else:
            self.cache_writes_5m += usage.cache_creation_input_tokens or 0
        self.output += usage.output_tokens

    @property
    def hit_rate(self) -> float:
        cacheable = self.cache_reads + self.cache_writes_5m + self.cache_writes_1h
        return self.cache_reads / cacheable if cacheable else 0.0

    def cost_usd(self, base_input_per_mtok: float, output_per_mtok: float) -> float:
        # Sonnet 4.6: base_input=3.00, output=15.00
        # Opus 4.7:   base_input=15.00, output=75.00
        write_5m = self.cache_writes_5m * base_input_per_mtok * 1.25
        write_1h = self.cache_writes_1h * base_input_per_mtok * 2.0
        reads    = self.cache_reads     * base_input_per_mtok * 0.10
        base     = self.base_input      * base_input_per_mtok
        out      = self.output          * output_per_mtok
        return (write_5m + write_1h + reads + base + out) / 1_000_000

stats = CacheStats()

def cached_call(client, **kwargs):
    response = client.messages.create(**kwargs)
    stats.record(response.usage)
    return response
```

Запустите агента от начала до конца, затем выведите долю попаданий.

```python
print(f"requests:    {stats.requests}")
print(f"hit rate:    {stats.hit_rate:.1%}")
print(f"cache reads: {stats.cache_reads:,}")
print(f"5m writes:   {stats.cache_writes_5m:,}")
print(f"1h writes:   {stats.cache_writes_1h:,}")
print(f"uncached in: {stats.base_input:,}")
print(f"USD:         ${stats.cost_usd(3.00, 15.00):.4f}")  # Sonnet 4.6 prices
```

Здоровый агент кодинга на 50 ходов на Sonnet 4.6 с system prompt на 8k обычно даёт:

- 95-98% попаданий на блок system prompt.
- 70-90% попаданий на блок сообщений в зависимости от того, насколько агрессивно вы перезапрашиваете.
- В 1.5-4 раза меньше совокупных трат, чем у того же агента без кеширования.

Если доля попаданий застряла на 0%, виноваты почти всегда три вещи: префикс ниже минимального порога токенов, недетерминированное значение (timestamp, случайный ID, порядок словаря) внутри кешируемого текста, или сообщения, переставленные между ходами.

## TTL на 1 час: когда он окупается

TTL по умолчанию 5 минут. Для агента в стиле чата это нормально: каждый ход освежает кеш, и небольшая надбавка за запись амортизируется на множестве чтений.

TTL на 1 час стоит **2x базовой стоимости input** при записи, но живёт в двенадцать раз дольше. Арифметика: если вы ожидаете хотя бы одно чтение раз в пять минут на протяжении часа, кеш на 5 минут работает. Если ваш трафик пиковый (кто-то запускает агента раз в 20 минут), кеш на 5 минут истекает между ходами, и вы снова и снова платите за запись. TTL на 1 час окупается в момент, когда за час простоя случаются два чтения кеша.

```python
# Python 3.11, anthropic 0.42 -- mixing TTLs
system=[
    {
        "type": "text",
        "text": STABLE_INSTRUCTIONS,             # the bedrock part
        "cache_control": {"type": "ephemeral", "ttl": "1h"},
    },
    {
        "type": "text",
        "text": SESSION_SCOPED_CONTEXT,          # changes per user session
        "cache_control": {"type": "ephemeral", "ttl": "5m"},
    },
],
```

При смешивании TTL записи с более длинным TTL должны идти **раньше** записей с более коротким. Если перевернёте, API отклонит запрос.

Никакой beta header не нужен. Старые `anthropic-beta: prompt-caching-2024-07-31` и более поздний `extended-cache-ttl-2025-04-11` сняты, хотя SDK всё ещё принимает их как no-op для обратной совместимости.

## Пять подвохов, ломающих долю попаданий

**1. Вшивание недетерминированного контента.** `datetime.now()` в вашем system prompt инвалидирует кеш каждую секунду. Частые виновники: timestamp'ы, ID запросов, случайные тестовые данные, добавленные ради разнообразия, JSON-сериализация, не фиксирующая порядок ключей. Если байты меняются, кеш промахивается.

**2. Перестановка инструментов или сообщений.** API хеширует байты в порядке. Сортировка массива инструментов между вызовами по-разному даёт разный хеш. Держите детерминированный порядок, в идеале как в файле конфигурации.

**3. Забыли переключить system со строки на массив.** `system="..."` (обычная строка) не принимает `cache_control`. Нужно использовать `system=[{"type": "text", "text": "...", "cache_control": {"type": "ephemeral"}}]`. SDK не предупреждает, когда вы передаёте строку с ожиданиями кеширования.

**4. Выход за окно lookback в 20 блоков.** Точка кеша видит только 20 блоков контента перед собой. В длинном цикле tool-use со множеством блоков tool_result ваша точка ближе к началу разговора рано или поздно выпадает за пределы. Добавьте вторую точку ближе к текущему ходу до того, как это произойдёт.

**5. Попытка попасть в один и тот же кеш из разных организаций или workspace'ов.** Кеши изолированы по организациям и, начиная с февраля 2026, по workspace'ам в API Anthropic и Azure. Если вы держите dev в одном workspace, а prod в другом, кешируемые префиксы у них общими не будут.

Чтобы глубже посмотреть, что оборачивает Anthropic SDK на стороне .NET, см. [Microsoft Agent Framework 1.0 для AI-агентов на C#](/ru/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) и [Поддержка BYOK в GitHub Copilot для провайдера Anthropic в VS Code](/ru/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/).

## Что делает "автоматическое кеширование" и почему этого недостаточно

В недавних релизах SDK добавили параметр `cache_control` верхнего уровня в `messages.create`. Установка его говорит API применять кеширование автоматически на основе эвристик. Работает, но выбирается одна точка, и вы не контролируете какая. Для одного длинного system prompt это нормально. Для цикла агента с каталогами инструментов, сводками и историей сообщений вам нужны явные точки. Авторежим лучше воспринимать как smoke test: включить один раз, чтобы убедиться, что кеширование работает в вашей сборке, а потом перейти к явным блокам `cache_control`.

Если вы при этом строите MCP-серверы, отдающие инструменты тому же агенту, принципы расположения те же. См. [Как построить свой MCP-сервер на C# на .NET 11](/ru/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/), [Как построить MCP-сервер на TypeScript, оборачивающий CLI](/ru/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) и [Как построить свой MCP-сервер на Python с официальным SDK](/ru/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) для серверной стороны. Руководство по расстановке точек применимо к клиенту, который их вызывает.

## Табличный взгляд на то, когда кеширование окупается

Для прикидки на коленке возьмите размер префикса в токенах (`P`), число ожидаемых чтений на одну запись (`R`) и множитель TTL кеша (`m`, где `m=1.25` для 5m и `m=2.0` для 1h). Точка безубыточности по числу чтений для одного закешированного префикса по сравнению с базовой линией без кеша:

```
R_breakeven = (m - 1) / (1 - 0.1)
            = (m - 1) / 0.9
```

Это **0.28 чтения** для TTL на 5 минут и **1.11 чтения** для TTL на 1 час. Иначе говоря, кеш на 5 минут окупается уже после одного чтения в любом реалистичном сценарии, а кеш на 1 час окупается после второго. По сути не существует сценария цикла агента, где кеширование было бы неправильным выбором; единственный вопрос, какой TTL выбрать.

Подробнее о паттернах циклов агента, выигрывающих от кеширования, см. [Как написать CLAUDE.md, действительно меняющий поведение модели](/ru/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) и [Как запланировать повторяющуюся задачу Claude Code, которая сортирует issue в GitHub](/ru/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/).

## Справочные ссылки

- [Документация по prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)
- [Anthropic Python SDK на PyPI](https://pypi.org/project/anthropic/)
- [Anthropic TypeScript SDK на npm](https://www.npmjs.com/package/@anthropic-ai/sdk)
- [Цены API Anthropic](https://docs.claude.com/en/docs/about-claude/pricing)
