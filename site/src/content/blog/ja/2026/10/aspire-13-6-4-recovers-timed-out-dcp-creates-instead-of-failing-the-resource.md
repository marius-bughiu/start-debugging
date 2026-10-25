---
title: "Aspire 13.6.4 はタイムアウトした DCP の作成呼び出しを回復し、リソースを失敗させなくなりました"
description: "Aspire 13.6.4 は、1 回のタイムアウトまたは HTTP 504 の DCP 作成呼び出しでリソースが FailedToStart になる問題を解消し、低速な CI ランナー向けに引き上げられる 3 つの DcpPublisher タイムアウトを公開します。"
pubDate: 2026-10-25
tags:
  - "aspire"
  - "dotnet"
  - "ci"
lang: "ja"
translationOf: "2026/10/aspire-13-6-4-recovers-timed-out-dcp-creates-instead-of-failing-the-resource"
translatedBy: "claude"
translationDate: 2026-10-25
---

Aspire 13.6 の AppHost が CI でランダムに失敗し、リソースが `FailedToStart` のままになるなら、2026 年 10 月 24 日にリリースされた [Aspire 13.6.4](https://github.com/microsoft/aspire/releases/tag/v13.6.4) が求めているパッチです。作成呼び出しが時間内に返らなかったときに AppHost が Developer Control Plane (DCP) とどのようにやり取りするかが変わり、ついにそのタイムアウトを調整できるようになりました。

## 1 回の遅い作成呼び出しでリソースが落ちていました

13.6.0 以降、DCP の API サーバーへの `Create` リクエストが 1 回でもタイムアウトするか HTTP 504 を返すと、再試行されませんでした。リソースはそのまま `FailedToStart` になり、それを `WaitFor` していたものはすべて "Stopped waiting for resource ... because it failed to start." で失敗しました。[microsoft/aspire#20691](https://github.com/microsoft/aspire/issues/20691) の報告は、2 vCPU の GitHub ホスト型 `macos-15-intel` ランナーで、依存関係がまだ起動中のうちにグラフ内の最後のプロジェクトが起動したケースでした。ログには、20 秒のクライアント予算後の Polly `TimeoutRejectedException`、または約 34 秒後に DCP から返る `GatewayTimeout` のどちらかが記録されていました。

厄介なのは、タイムアウトが作成の失敗を意味しない点です。クライアントが諦めた直後に DCP がオブジェクトをコミットしている場合があるため、盲目的な再試行も安全ではありません。

## まず確認し、次に同じオブジェクトを再試行します

[#20752](https://github.com/microsoft/aspire/pull/20752) の修正 ([#20868](https://github.com/microsoft/aspire/pull/20868) でバックポート) は、タイムアウト、502、503、504、429 の作成呼び出しを曖昧なものとして扱います。再試行の前に、AppHost は同じ名前のオブジェクトに対して `GET` を発行します。DCP がすでに作成していれば、そのオブジェクトが使われ、リソースは起動を続けます。`GET` が 404 を返した場合、作成は最大 5 秒に制限されたジッター付きバックオフで再試行されます。再試行時の "already exists" という応答も受け入れられます。以前の試行が確認チェックの後に反映された可能性があるためです。`GET` が重要なのは、2 回目の `POST` がブロックされうる API サーバーの公開ロックを回避できるからです。

KubernetesClient パッケージ自身の 100 秒の `HttpClientTimeout` は無効化されました。そのため、設定した予算を途中で打ち切って無関係なキャンセルとして現れることはなくなりました。

## DcpPublisher の 3 つの設定

予算は、AppHost 構成の通常のオプションになりました。

| キー | 既定値 | 目的 |
| --- | --- | --- |
| `DcpPublisher:KubernetesApiTimeout` | 40 s | API 操作ごと |
| `DcpPublisher:KubernetesInitializationAdditionalTimeout` | 20 s | 最初の操作が成功するまで追加される |
| `DcpPublisher:KubernetesCreateRecoveryTimeout` | 2 min | 1 回の作成を回復するための合計予算 |

各値は 1 秒以上 10 分以下である必要があり、API タイムアウトと初期化タイムアウトの合計も 10 分を超えられません。超えると、起動時にオプションの検証が失敗します。確立済みの watch ストリームとログストリームは、これらの制限の対象外です。

リソースの限られたランナーでは、AppHost の `appsettings.json` で引き上げてください。

```json
{
  "DcpPublisher": {
    "KubernetesApiTimeout": "00:01:30",
    "KubernetesInitializationAdditionalTimeout": "00:00:45",
    "KubernetesCreateRecoveryTimeout": "00:05:00"
  }
}
```

あるいは、リポジトリの既定値はそのままにして CI ワークフローだけで設定することもできます。環境変数も `IConfiguration` を通じてバインドされるためです。

```yaml
env:
  DcpPublisher__KubernetesApiTimeout: "00:01:30"
  DcpPublisher__KubernetesCreateRecoveryTimeout: "00:05:00"
```

アップグレードするには、`Aspire.AppHost.Sdk` のバージョンと `Aspire.Hosting.*` パッケージを `13.6.4` に上げてください。同じリリースでは、Unix 上の CLI 診断ログも `0700` ディレクトリ内の `0600` ファイルに制限されます。これらのログにダッシュボードのログイン URL が含まれる場合があるためです。13.6 系に追いつこうとしているなら、[ダッシュボードの実行履歴の記事](/ja/2026/09/aspire-13-6-dashboard-keeps-your-last-ten-runs/)で、そのリリースの目玉機能を取り上げています。
