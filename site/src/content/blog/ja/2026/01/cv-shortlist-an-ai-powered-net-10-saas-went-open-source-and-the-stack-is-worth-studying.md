---
title: "CV Shortlist: .NET 10 の AI SaaS に関する過去の記録"
description: "CV Shortlist の作者の発表、過去の README の説明、公開リポジトリが利用できなくなった後も参考になる .NET AI の設計上の論点。"
pubDate: 2026-01-18
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/01/cv-shortlist-an-ai-powered-net-10-saas-went-open-source-and-the-stack-is-worth-studying"
translatedBy: "claude"
translationDate: 2026-04-29
---

**2026年11月2日確認:** 以前の公開リポジトリ `github.com/mihnea-radulescu/cvshortlist` は GitHub API を含めて 404 を返します。削除、非公開化、移動のどれかは判断できず、公開の移転先も確認できませんでした。本記事は過去の記録であり、現在実行できるソースコードの解説ではありません。

## 作者が発表した内容

[元の発表](https://www.reddit.com/r/csharp/comments/1qgbjo4/saas_educational_free_and_opensource_example_cv/) で Mihnea Radulescu は、2025年11月に商用 SaaS の開発を開始し、その後サービスを終了して MIT ライセンスの学習用プロジェクトとして提供したと説明しています。挙げられた技術は .NET 10、ASP.NET Core、Blazor Server、Azure Cloud、Azure AI Foundry です。目的は応募者の候補絞り込みでした。これは作者の説明であり、精度や本番運用への適性を独立に実証したものではありません。

以前の GitHub README のキャッシュには、Document Intelligence で PDF を抽出し、GPT-5 系モデルで求人情報と比較する構成が記載されています。EF Core 10、Azure のストレージやデータベース、Azure AI リソースを引き続き必要とするセルフホスト版も挙げられ、導入説明では `gpt-5-mini` が指定されていました。ただし、現在のコード、モデルの提供状況、必要な構成、テスト結果の証明にはなりません。今回、取得できないリポジトリのビルドやコード監査は行っていません。

## リポジトリがなくても検討できる設計

文書抽出とモデル処理を分ける設計は検討する価値があります。Microsoft の [Document Intelligence レイアウトモデルの資料](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0) は、テキスト、表、構造の抽出を説明しています。モデルへ渡す前に、自分の文書で抽出結果を検証してください。抽出後に LLM を呼ぶだけでは、RAG アーキテクチャであることは示せません。

設定をソースコードから分離し、必要な項目を検証します。README の user secrets・環境変数に関する記述は過去のプロジェクト方針であり、完全な本番セキュリティ設計ではありません。[Secret Manager の資料](https://learn.microsoft.com/en-us/aspnet/core/security/app-secrets?view=aspnetcore-10.0) が示すとおり、user secrets は開発用で暗号化されません。環境変数にも適切なアクセス制御が必要です。以前の説明用 `Program.cs` は削除しました。リポジトリから確認したコードではなく、C# の `required` プロパティだけでは `ValidateDataAnnotations()` による実行時の必須値検証にならなかったためです。

現在参照できる学習資料として [Generative AI for Beginners .NET v2](/ja/2026/03/generative-ai-beginners-dotnet-v2-dotnet10-meai/) があります。文書処理やモデル統合を学ぶ際は、利用できないプロジェクトをデプロイ用のひな形として扱わず、リンク先の教材を確認してください。

**2026年11月2日訂正:** 作者の発表と過去の README を、現在確認できるコードから区別しました。裏付けのない実装上の推奨と、未検証の設定例を削除しました。
