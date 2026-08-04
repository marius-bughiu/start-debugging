---
title: "NuGet の API キーは 8 月 17 日から最長 30 日に、古いキーはすべて 11 月 1 日に失効します"
description: "NuGet.org は 2026-08-17 に 365 日の API キーオプションを廃止し、新規キーを最長 30 日に制限したうえで、それ以前に作成されたキーをすべて 11 月 1 日に失効させます。何が壊れるのか、公開ワークフローを OIDC の trusted publishing へ移す方法を解説します。"
pubDate: 2026-08-04
tags:
  - "dotnet"
  - "nuget"
  - "ci-cd"
  - "security"
  - "github-actions"
lang: "ja"
translationOf: "2026/08/nuget-api-keys-capped-at-30-days-from-august-17"
translatedBy: "claude"
translationDate: 2026-08-04
---

.NET チームは 2026-08-03 に [Strengthening NuGet Supply Chain Security: Reducing API Key Lifetime](https://devblogs.microsoft.com/dotnet/strengthening-nuget-supply-chain-security-reducing-api-key-lifetime/) を公開しました。この記事には、無視するとリリースパイプラインが壊れる 2 つの確定した期日が書かれています。

## 2 つの期日

**2026-08-17**: 新規の API キーは最長 30 日に制限されます。nuget.org のキー作成画面から 365 日のオプションが消えます。

**2026-11-01**: 8 月 17 日より前に作成された API キーはすべて失効します。1 年のキーだけではありません。`NUGET_API_KEY` シークレットを 6 月に発行していた場合、隣に表示されている有効期限に関係なく 11 月 1 日に動かなくなります。

厄介なのは 2 つ目の期日です。タグ起動のリリースワークフローが 10 月以降実行されていなければ、11 月 1 日以降の最初の push で 401 になって失敗します。しかもその失敗は、本当にリリースが必要になるまで誰も見ていない job の中で起きます。

## 30 日のキーでも形として間違っている理由

30 日のキーは 365 日のキーよりましですが、リポジトリのシークレットストアに置かれた長命のシークレットであることに変わりはなく、しかも年 1 回だったローテーションが年 12 回になります。ローテーションの自動化は実作業です。正しいパッケージスコープで nuget.org のキーを発行し、GitHub や Azure DevOps に投入し、古いキーが失効済みであることを確認する必要があります。

Microsoft が全員に勧めている代替手段が [trusted publishing](https://learn.microsoft.com/en-us/nuget/nuget-org/trusted-publishing) で、こちらは OIDC を使います。CI システムが短命の署名付きトークンを発行し、nuget.org が登録済みのポリシーと照合して、**1 時間**だけ有効な一時 API キーを返します。1 つのトークンで得られるキーはちょうど 1 つです。永続的なものはどこにも保存されません。

GitHub Actions での書き方は小さなものです。

```yaml
publish:
  environment: release
  permissions:
    id-token: write   # required for GitHub to mint the OIDC token
    contents: read
  steps:
    - name: NuGet login (OIDC to temp API key)
      uses: NuGet/login@v1
      id: login
      with:
        user: ${{ secrets.NUGET_USER }}   # nuget.org profile name, not your email
    - name: Push
      run: >
        dotnet nuget push artifacts/*.nupkg
        --api-key ${{ steps.login.outputs.NUGET_API_KEY }}
        --source https://api.nuget.org/v3/index.json
        --skip-duplicate
```

初回のセットアップは、nuget.org の Account、Trusted Publishing にポリシーを 1 つ登録するだけです。リポジトリのオーナー、リポジトリ、ワークフローのファイル名 (`.github/workflows/` を付けない `release.yml`)、必要であれば環境名を指定します。GitLab でも利用でき、`id_tokens` のクレームを `POST https://www.nuget.org/api/v2/token` と交換します。

11 月までに知っておく価値のある落とし穴が 1 つあります。GitHub のプライベートリポジトリに対して作成したポリシーは、最初は **7 日間だけ一時的に有効**な状態で始まります。その期間内に公開が発生しないとポリシーは無効になります。nuget.org は復活攻撃 (resurrection attack) を防ぐためにポリシーを固定する必要があり、そのためのリポジトリ ID とオーナー ID は実際のトークン交換からしか得られないからです。ポリシーを登録したら使い捨ての push を 1 回実行してください。登録したまま放置するのは避けましょう。

複数パッケージのリリースをすでに運用している場合、その配線は [Independently Releasing Multiple NuGet Packages with MinVer + Trusted Publishing](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/) で扱っています。そうでなければ、今週できる最小限の対応は、まだ静的なキーで push しているパイプラインを洗い出すことと、失効通知を受け取る nuget.org のアカウントが実際に誰かに読まれているかを確認することです。
