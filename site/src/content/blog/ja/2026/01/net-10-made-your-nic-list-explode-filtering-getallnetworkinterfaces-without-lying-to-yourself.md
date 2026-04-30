---
title: ".NET 10 で NIC のリストが爆発した? 自分を欺かずに GetAllNetworkInterfaces() をフィルターする"
description: ".NET 10 で Hyper-V、Docker、WSL、VPN の仮想アダプターがリストを埋め尽くしてしまうとき、GetAllNetworkInterfaces() をどうフィルターするか。トレードオフを明示した 2 段階フィルター付き。"
pubDate: 2026-01-08
tags:
  - "dotnet"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/01/net-10-made-your-nic-list-explode-filtering-getallnetworkinterfaces-without-lying-to-yourself"
translatedBy: "claude"
translationDate: 2026-04-30
---
.NET 8 から .NET 10 にアプリを移行した直後、`NetworkInterface.GetAllNetworkInterfaces()` が突然 10 個ではなく 80 個のアダプターを返すようになっても、それは気のせいではありません。これは 2026 年 1 月 7 日のスレッドで取り上げられた話題で、まさに「マイナー」な動作変更が breaking change のように感じられる、現実世界の痛みそのものです: Hyper-V、Docker、WSL、VPN、ループバック、その他のシステムアダプターからの仮想インターフェースが、「本物」の Ethernet や Wi-Fi デバイスを押しのけ始めます。

ソース: [NetworkInterface.GetAllNetworkInterfaces breaking change (r/dotnet)](https://www.reddit.com/r/dotnet/comments/1q6ippd/networkinterfacegetallnetworkinterfaces_breaking/)

## 不都合な真実: 「物理」はヒューリスティックである

`System.Net.NetworkInformation` は、マシン、ドライバー、Windows の機能をまたいで信頼できる「これは物理 NIC です」という公式の単一のブール値を提供してくれません。最も安全な戦略は、**自分の製品の要件にマッチするフィルターを構築する**ことと、そのフィルターを監査可能かつテスト可能に保つことです。

「接続性に役立つ」と通常相関する厳しめのシグナルから始めます:

-   `OperationalStatus.Up`
-   インターフェース種別 (`Ethernet`、`Wireless80211` など)
-   IPv4/IPv6 の unicast アドレス、ゲートウェイ、DNS サーバーの有無 (ユースケース次第)

その後、第 2 段階として、より緩く環境固有な除外 (Docker、Hyper-V、WSL、VPN) を追加します。

## トレードオフを明示した 2 段階のフィルター

スレッドではこのアプローチが提案されていました (可読性のために削減し、少しだけ強化しています):

```cs
using System.Net.NetworkInformation;

var candidates = NetworkInterface.GetAllNetworkInterfaces()
    .Where(nic => nic.OperationalStatus == OperationalStatus.Up)
    .Where(nic => nic.NetworkInterfaceType is
        NetworkInterfaceType.Ethernet or
        NetworkInterfaceType.Wireless80211 or
        NetworkInterfaceType.GigabitEthernet)
    .Where(nic => !LooksVirtual(nic))
    .ToArray();

static bool LooksVirtual(NetworkInterface nic)
{
    var desc = (nic.Description ?? "").ToLowerInvariant();
    var name = (nic.Name ?? "").ToLowerInvariant();

    string[] keywords =
    {
        "virtual", "hyper-v", "vmware", "virtualbox",
        "docker", "vpn", "tap-", "wsl", "pseudo"
    };

    return keywords.Any(k => desc.Contains(k) || name.Contains(k));
}
```

ハック的か? はい。しかし正直でもあります: ポリシーをコードに埋め込んでいることを認めているのです。

これをもう少し脆くないものにするには、文字列だけに頼らないでください:

-   `nic.GetIPProperties().UnicastAddresses` を確認し、自分のシナリオでルーティング可能なアドレスを持たないインターフェースは無視します。
-   デフォルトゲートウェイ (`GatewayAddresses`) や DNS サーバー (`DnsAddresses`) を必須にするかどうかを検討します。
-   フィルターで落としたもの (種別、説明、id) をログに出して、新しいドライバーや VPN クライアントが現れたときに調整できるようにします。

## 好奇心ではなく、本番インシデントとしてデバッグする

.NET のバージョンによってアダプター数が変わるときは、観測可能な動作差として扱ってください:

-   ビフォア/アフターのスナップショット (種別、ステータス、説明、id、IP プロパティ) を取ります。
-   「このマシンは少なくとも 1 つの Wi-Fi または Ethernet 候補を生み出すはず」と主張する、ユニットテスト風の小さなハーネスを書きます。
-   挙動がプラットフォーム/ランタイムの変更に起因するなら、既存の issue を検索するか、最小再現付きで起票します。

.NET 10 はあなたに生のリストを渡してくれます。「本物」が何を意味するかは、依然としてあなたのアプリが決めなければなりません。
