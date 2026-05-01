---
title: "Python: Azure AI Language サービスでテキストの言語を判定する"
description: "Azure AI Language サービスと Python SDK の azure-ai-textanalytics を使ってテキストの言語を判定する方法を、コード例と API ペイロード例とともに解説します。"
pubDate: 2023-11-18
tags:
  - "ai"
  - "azure"
  - "python"
lang: "ja"
translationOf: "2023/11/python-detect-text-language-using-azure-ai-language-service"
translatedBy: "claude"
translationDate: 2026-05-01
---
Azure AI Language サービスは、テキストからの言語判定、感情分析、キーフレーズ抽出、固有表現認識および固有表現リンクなど、一般的なテキスト分析手法のための API を開発者に提供します。

## プロビジョニング

[![](/wp-content/uploads/2023/11/image-11.png)](/wp-content/uploads/2023/11/image-11.png)

Azure AI Language でテキストを分析する最初のステップは、Azure 上で `Language service` リソースをプロビジョニングすることです。テスト目的では、月あたり 5000 トランザクションの上限がある無料の `F0` ティアを使用できます。

ティアの上限に加えて、リクエストの上限も考慮する必要があります。

-   1 リクエストにつき最大 1000 件のドキュメントを送信できます
-   各ドキュメントの最大長は 5120 文字です

リソースを作成したら、**Keys and Endpoint** に移動してエンドポイント URL と認可キー（どちらか一方で動作します）を取得します。後で API を呼び出す際にこれらが必要になります。

## 言語判定 API

言語判定 API は 1 件以上のテキストドキュメントを受け取り、それぞれについて検出された言語と信頼度スコアを返します。これは任意のテキスト入力を扱う際、テキストの言語が分からず、それが後続の分析や処理に重要な役割を果たす場合に便利です。たとえばチャットボットのシナリオでは、ユーザーの言語に合わせて応対するためにこの情報を活用できます。

各入力ドキュメントは、その `text` 内容と一意の `id`（このリクエストの中で一意）で構成されます。さらに、各入力ドキュメントに対して `countryHint` を指定すると、予測精度を向上させることができます。

サンプルの JSON ペイロードを見てみましょう。

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

各入力ドキュメントに対して、検出された言語（`name` と `iso6391Name`）、信頼度スコア、警告のリスト（あれば）が返されます。

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

入力テキストがサービスで認識できない場合、言語は `(Unknown)`、`confidenceScore` は `0` になります。

## 試してみる

言語判定 API を試すには、新しい `.py` スクリプトファイルを作成し、`azure-ai-textanalytics` パッケージをインストールします。

```bash
pip install azure-ai-textanalytics==5.3.0
```

パッケージのインストールが終わったら、まず `TextAnalyticsClient` のインスタンスを作成します。

```python
from azure.core.credentials import AzureKeyCredential
from azure.ai.textanalytics import TextAnalyticsClient

credential = AzureKeyCredential('<your-authorization-key>')
ai_client = TextAnalyticsClient(endpoint='https://<your-resource-name>.cognitiveservices.azure.com/', credential=credential)
```

エンドポイントと認可キーは、自分のリソースの **Keys and Endpoint** ページで取得した値に置き換えてください。これでサービスを呼び出す準備ができました。

`TextAnalyticsClient` には `detect_language` メソッドがあり、`List[str]`、`List[DetectLanguageInput]`、`List[Dict[str, str]]` のいずれかを受け取るオーバーロードを持っています。

このメソッドを少し見ていきましょう。まず、1 つのテキストの言語を判定します。

```python
detectedLanguage = ai_client.detect_language(documents=['Hello, world!'])[0]
print(detectedLanguage)
```

レスポンスは次のようになります。

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

次は、より複雑なシナリオです。先ほどの JSON ペイロードの例と同様に、複数のドキュメントに一意の識別子を関連付けて送信し、そのうち 1 つのドキュメントには `country_hint` も指定します。コードは次のようになります。

```python
inputDocuments: List[DetectLanguageInput] = [
    DetectLanguageInput(id="1", text="Good morning", country_hint = "US"),
    DetectLanguageInput(id="2", text="Hello, je m'appelle Marius!")
]

detectedLanguages = ai_client.detect_language(inputDocuments)
print(detectedLanguages)
```

レスポンスは次のようになります。

```python
[
  DetectLanguageResult(id=1, primary_language=DetectedLanguage(name=English, iso6391_name=en, confidence_score=1.0), warnings=[], statistics=None, is_error=False, kind=LanguageDetection), 
  DetectLanguageResult(id=2, primary_language=DetectedLanguage(name=French, iso6391_name=fr, confidence_score=0.98), warnings=[], statistics=None, is_error=False, kind=LanguageDetection)
]
```
