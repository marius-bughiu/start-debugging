---
title: "Как определить язык текста с помощью службы Azure AI Language"
description: "Узнайте, как определять язык текста с помощью службы Azure AI Language: подготовка ресурса, payload API и примеры на C# с использованием TextAnalyticsClient."
pubDate: 2023-11-16
tags:
  - "ai"
  - "azure"
lang: "ru"
translationOf: "2023/11/how-to-detect-text-language-using-azure-ai-language-service"
translatedBy: "claude"
translationDate: 2026-05-01
---
Служба Azure AI Language предоставляет разработчикам API для распространённых задач анализа текста, таких как определение языка по тексту, анализ тональности, извлечение ключевых фраз, а также распознавание и связывание именованных сущностей.

## Подготовка

[![](/wp-content/uploads/2023/11/image-11.png)](/wp-content/uploads/2023/11/image-11.png)

Первый шаг при анализе текста с помощью Azure AI Language — подготовка ресурса `Language service` в Azure. Для тестирования можно использовать бесплатный уровень `F0` с лимитом 5000 транзакций в месяц.

Помимо ограничений уровня, нужно учитывать и ограничения запросов:

-   за один запрос можно отправить максимум 1000 документов
-   и каждый документ может иметь максимальную длину 5120 символов

После того как ресурс создан, перейдите в **Keys and Endpoint**, чтобы получить URL вашей конечной точки и ключ авторизации (подойдёт любой из двух). Они нам понадобятся позже, когда мы начнём вызывать API.

## API определения языка

API определения языка принимает один или несколько текстовых документов и для каждого из них возвращает определённый язык вместе с оценкой уверенности. Это полезно при работе с произвольным текстовым вводом, когда вы не знаете язык текста, и это может играть важную роль в дальнейшем анализе или действиях. Например, в сценарии с чат-ботом эта информация может помочь общаться с пользователем на его собственном языке.

Каждый входной документ состоит из содержимого `text` и уникального `id` (уникального в рамках данного запроса). Кроме того, для каждого входного документа можно указать `countryHint`, чтобы повысить качество предсказания.

Рассмотрим пример JSON-payload:

```json
{
  "kind": "LanguageDetection",
  "parameters": {
    "modelVersion": "latest"
  },
  "analysisInput": {
    "documents": [
      {
        "id": "1",
        "text": "Good morning",
        "countryHint": "US"
      },
      {
        "id": "2",
        "text": "Hello, je m'appelle Marius!"
      }
    ]
  }
}
```

Для каждого входного документа мы получим в ответ определённый язык (`name` и `iso6391Name`) вместе с оценкой уверенности и списком предупреждений (если они есть).

```json
{
  "kind": "LanguageDetectionResults",
  "results": {
    "documents": [
      {
        "detectedLanguage": {
          "confidenceScore": 1,
          "iso6391Name": "en",
          "name": "English"
        },
        "id": "1",
        "warnings": []
      },
      {
        "detectedLanguage": {
          "confidenceScore": 0.98,
          "iso6391Name": "fr",
          "name": "French"
        },
        "id": "2",
        "warnings": []
      }
    ],
    "errors": [],
    "modelVersion": "2022-10-01"
  }
}
```

Если ваш входной текст не может быть распознан службой, языком будет `(Unknown)` с `confidenceScore`, равным `0`.

## Попробуем на практике

Чтобы попробовать API определения языка, создайте новое консольное приложение и установите NuGet-пакет `Azure.AI.TextAnalytics`. После установки пакета мы начинаем с создания экземпляра `TextAnalyticsClient`.

```cs
using Azure.AI.TextAnalytics;
using Azure;

var aiClient = new TextAnalyticsClient(
    new Uri("https://my-service.cognitiveservices.azure.com/"),
    new AzureKeyCredential("98c1961504db412c9fd36d15984c9d9e"));
```

Не забудьте заменить endpoint и ключ авторизации на данные, полученные на странице **Keys and Endpoint** вашего ресурса. После этого можно вызывать службу.

`TextAnalyticsClient` предоставляет два метода для определения языка:

-   `DetectLanguageAsync`, который работает с одним фрагментом текста и имеет необязательный параметр `countryHint`
-   `DetectLanguageBatchAsync`, который работает с несколькими документами, принимая либо строки, либо экземпляры `DetectLanguageInput`

Рассмотрим их по очереди. Сначала определение языка одного фрагмента текста:

```cs
var response = await aiClient.DetectLanguageAsync("Hello, world!");
var detectedLanguage = response.Value;
```

`DetectLanguageAsync` возвращает `Task<Response<DetectedLanguage>>`, поэтому, чтобы добраться до самого `DetectedLanguage`, нужно обратиться к `.Value` у результата задачи. Ответ будет выглядеть так:

```json
{
  "Name": "English",
  "Iso6391Name": "en",
  "ConfidenceScore": 1,
  "Warnings": []
}
```

Теперь к более сложному сценарию, где, как и в примере JSON-payload выше, мы отправляем несколько документов со связанными уникальными идентификаторами и для одного из документов также передаём `CountryHint`. Код будет выглядеть так:

```cs
var inputDocuments = new DetectLanguageInput[]
{
    new("1", "Good morning") { CountryHint = "US" },
    new("2", "Hello, je m'appelle Marius!"),
};

var detectedLanguages = (await aiClient.DetectLanguageBatchAsync(inputDocuments)).Value;
```

`detectedLanguages` имеет тип `DetectLanguageResultCollection`, который на самом деле представляет собой `ReadOnlyCollection` с дополнительной информацией поверх (статистика по пакету документов и тому, как он был обработан службой, плюс версия модели службы Language, использованной для операции).

```json
[
  {
    "PrimaryLanguage": {
      "Name": "English",
      "Iso6391Name": "en",
      "ConfidenceScore": 1,
      "Warnings": []
    },
    "Id": "1"
  },
  {
    "PrimaryLanguage": {
      "Name": "French",
      "Iso6391Name": "fr",
      "ConfidenceScore": 0.98,
      "Warnings": []
    },
    "Id": "2"
  }
]
```
