---
title: "Python: определение языка текста с помощью службы Azure AI Language"
description: "Узнайте, как определять язык текста с помощью службы Azure AI Language и Python SDK azure-ai-textanalytics, с примерами кода и payload API."
pubDate: 2023-11-18
tags:
  - "ai"
  - "azure"
  - "python"
lang: "ru"
translationOf: "2023/11/python-detect-text-language-using-azure-ai-language-service"
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

Чтобы попробовать API определения языка, создайте новый файл скрипта `.py` и установите пакет `azure-ai-textanalytics`.

```bash
pip install azure-ai-textanalytics==5.3.0
```

После установки пакета мы начинаем с создания экземпляра `TextAnalyticsClient`.

```python
from azure.core.credentials import AzureKeyCredential
from azure.ai.textanalytics import TextAnalyticsClient

credential = AzureKeyCredential('<your-authorization-key>')
ai_client = TextAnalyticsClient(endpoint='https://<your-resource-name>.cognitiveservices.azure.com/', credential=credential)
```

Не забудьте заменить endpoint и ключ авторизации на данные, полученные на странице **Keys and Endpoint** вашего ресурса. После этого можно вызывать службу.

`TextAnalyticsClient` содержит метод `detect_language` с перегрузками, принимающими `List[str]`, `List[DetectLanguageInput]` или `List[Dict[str, str]]`.

Рассмотрим этот метод подробнее. Сначала определим язык одного фрагмента текста:

```python
detectedLanguage = ai_client.detect_language(documents=['Hello, world!'])[0]
print(detectedLanguage)
```

Ответ будет выглядеть так:

```python
{
  'id': '0', 
  'primary_language': DetectedLanguage(name=English, iso6391_name=en, confidence_score=1.0), 
  'warnings': [], 
  'statistics': None, 
  'is_error': False, 
  'kind': 'LanguageDetection'
}
```

Теперь к более сложному сценарию, где, как и в примере JSON-payload выше, мы отправляем несколько документов со связанными уникальными идентификаторами и для одного из документов также передаём `country_hint`. Код будет выглядеть так:

```python
inputDocuments: List[DetectLanguageInput] = [
    DetectLanguageInput(id="1", text="Good morning", country_hint = "US"),
    DetectLanguageInput(id="2", text="Hello, je m'appelle Marius!")
]

detectedLanguages = ai_client.detect_language(inputDocuments)
print(detectedLanguages)
```

Ответ будет выглядеть так:

```python
[
  DetectLanguageResult(id=1, primary_language=DetectedLanguage(name=English, iso6391_name=en, confidence_score=1.0), warnings=[], statistics=None, is_error=False, kind=LanguageDetection), 
  DetectLanguageResult(id=2, primary_language=DetectedLanguage(name=French, iso6391_name=fr, confidence_score=0.98), warnings=[], statistics=None, is_error=False, kind=LanguageDetection)
]
```
