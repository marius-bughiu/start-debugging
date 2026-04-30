---
title: "Claude Code 2.1.122 позволяет выбрать уровень сервиса Bedrock через переменную окружения"
description: "Claude Code v2.1.122 добавляет переменную окружения ANTHROPIC_BEDROCK_SERVICE_TIER, отправляемую как заголовок X-Amzn-Bedrock-Service-Tier. Установите flex для скидки 50 процентов на вызовы агента или priority для более быстрых ответов, без изменений кода SDK."
pubDate: 2026-04-30
tags:
  - "claude-code"
  - "ai-agents"
  - "aws-bedrock"
  - "dotnet"
lang: "ru"
translationOf: "2026/04/claude-code-2-1-122-bedrock-service-tier"
translatedBy: "claude"
translationDate: 2026-04-30
---

Релиз Claude Code v2.1.122 от 28 апреля 2026 года добавил однострочный переключатель, которого тихо ждали все, кто запускает агент на AWS Bedrock: новую переменную окружения `ANTHROPIC_BEDROCK_SERVICE_TIER`, выбирающую уровень сервиса Bedrock для каждого запроса. Установите её в `default`, `flex` или `priority`, и CLI передаст значение как заголовок `X-Amzn-Bedrock-Service-Tier`. Никаких изменений кода SDK. Никаких правок JSON-конфигурации. Одна переменная окружения.

## Почему это важно ещё до того, как вы прочтёте остальное

AWS представил уровни инференса Priority и Flex для Bedrock в ноябре 2025 года как способ обменивать задержку на стоимость. Согласно [странице уровней сервиса Bedrock](https://aws.amazon.com/bedrock/service-tiers/), Flex даёт скидку 50 процентов по сравнению со Standard в обмен на "увеличенную задержку", а Priority - это премия 75 процентов, перемещающая ваши запросы в начало очереди. Для агента вроде Claude Code, который запускает длинные последовательности шагов с использованием инструментов в рамках сессии, арифметика очевидна. Длинная evergreen-задача, работавшая на default, могла бы стоить вдвое меньше на Flex, если вы можете смириться с дополнительным временем выполнения, а отладочная сессия, где вы следите за терминалом, на Priority ощущалась бы быстрее.

До v2.1.122 единственным способом выбрать уровень с Claude Code на Bedrock было самостоятельно обернуть слой запросов или пропускать всё через прокси, способный внедрить заголовок. [Feature request](https://github.com/anthropics/claude-code/issues/16329), вошедший в этот релиз, закрывает этот пробел.

## Фактическое использование

```bash
# Cheap background agents that triage issues overnight
export ANTHROPIC_BEDROCK_SERVICE_TIER=flex
claude --from-pr https://github.acme.internal/acme/api/pull/482

# Interactive debug session, paying for speed
export ANTHROPIC_BEDROCK_SERVICE_TIER=priority
claude
```

CLI отправляет значение дословно как `X-Amzn-Bedrock-Service-Tier` в запросе InvokeModel, то есть это та же сантехника, которую CloudTrail и CloudWatch уже фиксируют в `ServiceTier` и `ResolvedServiceTier`. Поэтому если у вашей команды платформы есть дашборды по затратам Bedrock в разрезе уровней, трафик Claude Code теперь попадает в нужную корзину без дополнительной работы.

## Осторожно с ResolvedServiceTier

Заголовок - это запрос, а не гарантия. AWS возвращает уровень, который фактически вас обслужил, в `ResolvedServiceTier`, и Flex-запросы могут быть понижены, если flex-пул модели насыщен. Полный список того, какие модели поддерживают Priority и Flex, находится на [странице цен Bedrock](https://aws.amazon.com/bedrock/pricing/), и она отстаёт от последних релизов моделей на недели, поэтому подтвердите, что ID модели, с которым вы запускаете Claude Code, в нём присутствует, прежде чем зашивать `flex` в CI-задачу. Если уровень не поддерживается, AWS прозрачно откатывается на уровень по умолчанию и выставляет счёт соответственно.

Строка `ANTHROPIC_BEDROCK_SERVICE_TIER` зарыта в середине changelog, но это самый дешёвый рычаг управления стоимостью Claude Code на Bedrock прямо сейчас. Полные заметки доступны на [странице релиза Claude Code v2.1.122](https://github.com/anthropics/claude-code/releases).
