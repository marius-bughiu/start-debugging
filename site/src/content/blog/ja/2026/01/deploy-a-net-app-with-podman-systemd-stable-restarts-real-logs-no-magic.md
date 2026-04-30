---
title: "Podman + systemd で .NET アプリをデプロイする: 安定した再起動、本物のログ、魔法なし"
description: "Linux VM 上で Podman と systemd を使って .NET 9 と .NET 10 のサービスをデプロイします。安定した再起動、journald 経由の本物のログ、そして本物のサービスのように管理されるコンテナ化アプリ -- Kubernetes は不要です。"
pubDate: 2026-01-10
tags:
  - "docker"
  - "dotnet"
lang: "ja"
translationOf: "2026/01/deploy-a-net-app-with-podman-systemd-stable-restarts-real-logs-no-magic"
translatedBy: "claude"
translationDate: 2026-04-30
---
今日 r/dotnet で出てきた話題です: Kubernetes でも壊れやすい `nohup` スクリプトでもない、.NET サービス向けの「退屈なデプロイ」のやり方を、人々はいまだに探しています。Linux VM 上にいるなら、Podman と systemd の組み合わせは堅実な落としどころです: 本物のサービスのように管理される、コンテナ化されたアプリになります。

元の議論: [https://www.reddit.com/r/dotnet/comments/1q8gq1u/how_to_deploy_net_applications_with_systemd_and/](https://www.reddit.com/r/dotnet/comments/1q8gq1u/how_to_deploy_net_applications_with_systemd_and/)

## .NET 9 と .NET 10 のサービスにこれがよく合う理由

-   **再起動は systemd が所有する**: プロセスがクラッシュすれば再起動され、明確な理由が得られます。
-   **ログは journald が所有する**: ローテートされたファイルをディスク上で探し回る必要はもうありません。
-   **Podman はデーモンレス**: systemd は必要なものだけを起動します。

## コンテナをビルドして実行する

.NET 9 アプリ向けの最小限の `Containerfile` です (.NET 10 でも同じように動きます。ベースタグを切り替えるだけです):

```dockerfile
FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS base
WORKDIR /app
EXPOSE 8080

FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /out

FROM base
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://+:8080
ENTRYPOINT ["dotnet", "MyApp.dll"]
```

それから:

```bash
podman build -t myapp:1 .
podman run -d --name myapp -p 8080:8080 myapp:1
```

## systemd に持たせる (役に立つ部分)

Podman は systemd が理解できるユニットファイルを生成できます。注意: `podman generate systemd` は Podman 4.4+ で [Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html) に取って代わられて非推奨になりましたが、生成される出力は引き続き動作し、概念を明確に示してくれます:

```bash
podman generate systemd --new --name myapp --files
```

これで `container-myapp.service` のようなものができます。所定の場所に移します:

```bash
sudo mv container-myapp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now container-myapp.service
```

これで運用コマンドがすっきりします:

```bash
sudo systemctl status container-myapp.service
sudo journalctl -u container-myapp.service -f
sudo systemctl restart container-myapp.service
```

## 後で自分を救う 2 つのディテール

### 設定を明示的にする

イメージにシークレットを焼き込むのではなく、環境変数とマウントした設定ディレクトリを使ってください。systemd ならドロップインファイルでオーバーライドを設定でき、安全に再起動できます。

### 現実に合った再起動ポリシーを選ぶ

設定不足ですぐに失敗するアプリの場合、無限の再起動はノイズにすぎません。マシンを叩きつけない再起動ポリシーを選んでください。systemd は遅延やバースト制限の制御を可能にします。

「これで合っているのか?」を判定する 1 つのテストが欲しい場合: VM を再起動して、SSH で入らなくても .NET サービスが立ち上がってくるかを見てください。それが基準線です。

参考リンク: [https://docs.podman.io/](https://docs.podman.io/)
