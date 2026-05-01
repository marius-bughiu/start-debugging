---
title: "Azure AI Language サービスでテキストの言語を判定する方法"
description: "Azure AI Language サービスを使ってテキストの言語を判定する方法を、リソースのプロビジョニング、API ペイロード、TextAnalyticsClient を使った C# SDK の例とともに解説します。"
pubDate: 2023-11-16
tags:
  - "ai"
  - "azure"
lang: "ja"
translationOf: "2023/11/how-to-detect-text-language-using-azure-ai-language-service"
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

言語判定 API を試すには、新しいコンソールアプリケーションを作成し、`Azure.AI.TextAnalytics` NuGet パッケージをインストールします。パッケージのインストールが終わったら、まず `TextAnalyticsClient` のインスタンスを作成します。

```cs
using Azure.AI.TextAnalytics;
using Azure;

var aiClient = new TextAnalyticsClient(
    new Uri("https://my-service.cognitiveservices.azure.com/"),
    new AzureKeyCredential("98c1961504db412c9fd36d15984c9d9e"));
```

エンドポイントと認可キーは、自分のリソースの **Keys and Endpoint** ページで取得した値に置き換えてください。これでサービスを呼び出す準備ができました。

`TextAnalyticsClient` には言語を判定するためのメソッドが 2 つ用意されています。

-   `DetectLanguageAsync`: 1 件のテキストに対して動作し、`countryHint` のオプションパラメーターを持ちます
-   `DetectLanguageBatchAsync`: 複数のドキュメントに対応し、文字列または `DetectLanguageInput` のインスタンスを受け取ります

それぞれを順に見ていきましょう。まず、1 つのテキストの言語を判定します。

```cs
var response = await aiClient.DetectLanguageAsync("Hello, world!");
var detectedLanguage = response.Value;
```

`DetectLanguageAsync` は `Task<Response<DetectedLanguage>>` を返すため、実際の `DetectedLanguage` を取得するには、タスクの結果に対して `.Value` を呼び出す必要があります。レスポンスは次のようになります。

```json
{
  "Name": "English",
  "Iso6391Name": "en",
  "ConfidenceScore": 1,
  "Warnings": []
}
```

次は、より複雑なシナリオです。先ほどの JSON ペイロードの例と同様に、複数のドキュメントに一意の識別子を関連付けて送信し、そのうち 1 つのドキュメントには `CountryHint` も指定します。コードは次のようになります。

```cs
var inputDocuments = new DetectLanguageInput[]
{
    new("1", "Good morning") { CountryHint = "US" },
    new("2", "Hello, je m'appelle Marius!"),
};

var detectedLanguages = (await aiClient.DetectLanguageBatchAsync(inputDocuments)).Value;
```

`detectedLanguages` の型は `DetectLanguageResultCollection` で、これは実質的には `ReadOnlyCollection` に追加情報（ドキュメントバッチに関する統計情報やサービスでの処理状況、操作に使用された Language サービスモデルのバージョン）を加えたものです。

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
