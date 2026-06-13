---
title: "解決: HttpClient で The SSL connection could not be established"
description: "内部の AuthenticationException が本当の原因を教えてくれます。信頼されないチェーン、名前の不一致、TLS バージョンの差です。証明書を信頼するか、ホストを修正するか、プロトコルを揃えてください。検証をまるごと無効化してはいけません。"
pubDate: 2026-06-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "httpclient"
lang: "ja"
translationOf: "2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient"
translatedBy: "claude"
translationDate: 2026-06-13
---

`HttpRequestException: The SSL connection could not be established, see inner exception` は、外側のメッセージが言っていることを意味することはほとんどありません。TLS ハンドシェイクが失敗しており、本当の原因は `InnerException` にあります。信頼されない証明書チェーン (`RemoteCertificateChainErrors`)、証明書と一致しないホスト (`RemoteCertificateNameMismatch`)、またはプロトコルの不一致です。まず内部の例外を読み、それからチェーン、ホスト、または TLS バージョンを修正してください。本番環境で `ServerCertificateCustomValidationCallback => true` に頼ってはいけません。それはハンドシェイクが提供するために存在する保護を無効にしてしまいます。

これは .NET 11 (`.NET 11`) の `HttpClient` に当てはまりますが、同じ `SslStream` の仕組みと同じ診断は .NET Core 3.1 までさかのぼります。

## エラーの文脈

外側の例外は一般的なものです。重要なのは内部の行です。

```
System.Net.Http.HttpRequestException: The SSL connection could not be established, see inner exception.
 ---> System.Security.Authentication.AuthenticationException: The remote certificate is invalid according to the validation procedure: RemoteCertificateChainErrors, RemoteCertificateNameMismatch
   at System.Net.Security.SslStream.SendAuthResetSignal(...)
   at System.Net.Http.ConnectHelper.EstablishSslConnectionAsync(...)
   at System.Net.Http.HttpConnectionPool.ConnectAsync(...)
```

.NET 8 以降では、内部の例外を手作業でこじ開ける必要すらありません。`HttpRequestException` は `HttpRequestError` の enum を持っており、ハンドシェイクの失敗は `HttpRequestError.SecureConnectionError` として現れます。

```csharp
// .NET 11, C# 14
try
{
    using var response = await client.GetAsync("https://api.example.com");
}
catch (HttpRequestException ex) when (ex.HttpRequestError == HttpRequestError.SecureConnectionError)
{
    // TLS handshake failed. Inspect ex.InnerException for the AuthenticationException.
    Console.WriteLine(ex.InnerException?.Message);
}
```

"according to the validation procedure:" の後ろの文字列が診断のすべてです。これは `SslPolicyErrors` フラグのカンマ区切りのリストであり、それぞれが別々の修正方法を指し示しています。

## なぜこれが起きるのか

ハンドシェイクは 3 つの理由のいずれかで失敗し、内部メッセージがどれかを示します。

- **`RemoteCertificateChainErrors`**: サーバーの証明書は本物ですが、お使いのマシンがそれに署名したチェーンを信頼していません。自己署名証明書、信頼ストアにない社内 CA、有効期限切れのリーフまたは中間証明書、あるいは中間証明書を送り忘れたサーバーは、すべてここに該当します。
- **`RemoteCertificateNameMismatch`**: 証明書は信頼されていますが、そこに記載された名前が接続先のホストと一致しません。`https://10.0.0.5` を呼び出したのに証明書は `api.internal` 向けに発行されている、あるいは `127.0.0.1` 向けの証明書に対して `https://localhost` にアクセスした、といった場合です。
- **`RemoteCertificateNotAvailable`**: サーバーが証明書をまったく提示しませんでした。これは通常、実際には TLS を提供していないポートに対して TLS で話していることを意味します。

4 つ目のクラスは `SslPolicyErrors` をまったく生成しません。内部例外が `Win32Exception` ("The client and server cannot communicate, because they do not possess a common algorithm") であるか、ポリシーのリストなしの素っ気ない "The SSL connection could not be established" である場合、両者は TLS バージョンや暗号スイートで合意できなかったということです。.NET 5 以降、クライアントの既定値は `SslProtocols.None` であり、これは「OS に利用可能な最良のものを選ばせる」という意味で、現在の OS では TLS 1.3 または TLS 1.2 をネゴシエートします。TLS 1.0/1.1 で止まっているサーバーや、その唯一の暗号スイートをお使いの OS が無効化しているサーバーは、このグループに該当します。

## 最小限の再現

チェーンエラーを再現する最小のプログラムは、自己署名またはその他の理由で信頼されない証明書を持つホストに `HttpClient` を向けます。

```csharp
// .NET 11, C# 14
using var client = new HttpClient();

// A host whose cert chains to a CA this machine does not trust.
using var response = await client.GetAsync("https://self-signed.badssl.com/");
response.EnsureSuccessStatusCode();
```

これを実行すると `RemoteCertificateChainErrors` の形が得られます。URL を `https://wrong.host.badssl.com/` に変えると、代わりに `RemoteCertificateNameMismatch` が得られます。これら 2 つの公開エンドポイントは、自分で壊れたサーバーを立てることなく、処理コードが正しく分岐することを確認する最速の方法です。

## 修正の詳細

内部例外に合致する修正を選んでください。「本番で正しい」から「開発専用」の順に並べています。

### 1. チェーンエラー: 証明書を信頼する、検証を回避しない

内部メッセージが `RemoteCertificateChainErrors` の場合、正しい修正はチェーンを信頼できるものにすることであり、チェックをやめることではありません。

社内 CA の場合は、CA のルート証明書をマシンの信頼ストアにインストールします。Linux では、これは PEM を OS の信頼バンドルに置くことを意味します。なぜなら Linux 上の .NET は .NET 固有のものではなく OpenSSL の信頼ストアを読むからです。

```bash
# Ubuntu/Debian: install a corporate root CA so .NET trusts it
sudo cp corp-root-ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates
```

Windows では、ルートを `Cert:\LocalMachine\Root` にインポートします。その後は、検証が OS のストアを読むため、`HttpClient` はコードの変更なしでチェーンを検証します。

マシンのストアに触れられない場合（ロックダウンされたホスト、短命なコンテナ）は、すべてを信頼する代わりに、期待する特定の証明書をピン留めします。これは、まさに 1 つの既知の証明書を受け入れつつ、他のすべてのサーバーに対しては検証を有効に保ちます。

```csharp
// .NET 11, C# 14
// Pin the expected leaf/intermediate by thumbprint. Real validation stays on
// for chains we did not explicitly pin.
var expectedThumbprint = "A1B2C3...";

var handler = new SocketsHttpHandler
{
    SslOptions = new SslClientAuthenticationOptions
    {
        RemoteCertificateValidationCallback = (sender, cert, chain, errors) =>
        {
            if (errors == SslPolicyErrors.None) return true;
            return cert is not null
                && cert.GetCertHashString().Equals(expectedThumbprint, StringComparison.OrdinalIgnoreCase);
        }
    }
};

using var client = new HttpClient(handler);
```

形に注目してください。コールバックは、すでに通過するチェーン (`SslPolicyErrors.None`) に対しては `true` を返し、それ以外ではピン留めした 1 つの証明書だけを受け入れます。それが証明書のピン留めと検証の無効化との違いです。

### 2. 名前の不一致: URL または証明書を修正する

`RemoteCertificateNameMismatch` は、証明書が発行されていない名前に接続したことを意味します。修正はほぼ常に、URL に正しいホスト、つまり証明書の Subject Alternative Name のリストに現れるホストを使うことです。IP アドレスで接続するのが典型的な引き金です。なぜなら証明書は IP ではなく DNS 名向けに発行されるからです。

URL が正しく、証明書が単に誤っている（あなたが管理するサーバーの本当の設定ミス）場合は、正しい SAN エントリで証明書を再発行します。証明書の名前と異なるアドレスでどうしても接続しなければならない場合は、名前のチェックを無効化する代わりに、ネゴシエートされる名前が証明書と一致するように TLS の SNI ホストを明示的に設定します。

```csharp
// .NET 11, C# 14
var handler = new SocketsHttpHandler
{
    SslOptions = new SslClientAuthenticationOptions
    {
        // Present this name in the TLS handshake even though the URL uses an IP.
        TargetHost = "api.internal"
    }
};
using var client = new HttpClient(handler);
```

### 3. プロトコルまたは暗号の差: TLS バージョンを揃える

ポリシーエラーのリストがなく、ハンドシェイクが単に失敗する場合、両端はプロトコルで合意できなかったということです。クライアントは `SslProtocols.None`（OS がネゴシエートする既定値）のままにして、サーバーが TLS 1.2 または 1.3 を提供するように修正してください。レガシーサーバーに合わせるためにクライアントを TLS 1.0/1.1 まで強制的に下げるのは最後の手段であり、いずれにせよ現代の OS ではこれらのプロトコルは OS レベルで無効化されていることが多く、明示的な設定は静かに何もしません。どうしても必要なら、こうなります。

```csharp
// .NET 11, C# 14 - last resort for a legacy server you cannot upgrade
var handler = new SocketsHttpHandler
{
    SslOptions = new SslClientAuthenticationOptions
    {
        EnabledSslProtocols = System.Security.Authentication.SslProtocols.Tls12
    }
};
```

### 4. ローカル HTTPS: ASP.NET Core の開発証明書を信頼する

開発中に `https://localhost` 経由で自分のサービスを呼び出していてこれに遭遇した場合、修正はローカルの開発証明書を一度信頼することです。

```bash
dotnet dev-certs https --trust
```

これが正しいローカルの修正です。これは検証を弱めません。なぜなら、クライアントにチェックを飛ばすよう指示するのではなく、`localhost` 向けの本物の信頼された証明書をインストールするからです。

## 落とし穴とバリエーション

**`ServerCertificateCustomValidationCallback => true` は修正ではありません。** これは StackOverflow で最も評価の高い回答ですが、使い捨てのテスト以外では誤りです。無条件に `true` を返すと、誰からの証明書でも受け入れてしまい、HTTPS を「余計な手順付きの平文」に変えて、TLS が防ぐまさにその中間者攻撃の穴を再び開けてしまいます。デモのブロックを解除するためにこれを使うなら、決して出荷されないように範囲を限定してください。`if (env.IsDevelopment())` でガードし、本番でオフになっていることを確認します。本当に特定の非公開証明書を受け入れる必要があるときに欲しいのは、修正 1 のピン留めコールバックです。

**Postman や curl では動くのに .NET では失敗する。** これらのツールと .NET は異なる信頼ストアを読みます。Linux 上の curl は OpenSSL のバンドル（これは .NET も読みます）を使いますが、Postman は独自の CA リストを同梱し、Windows のツールは Windows のストアを読みます。一方が信頼する CA が、他方でも自動的に信頼されるわけではありません。お使いの OS で .NET が実際に読むストアにルートをインストールしてください。

**Windows では動くのに Linux コンテナでは失敗する。** 同じ根本原因です。社内のルート CA は開発者の Windows 信頼ストアにありますが、コンテナイメージには一度も追加されていません。アプリが実行される前に Dockerfile で `update-ca-certificates` を使って CA を追加するか、マウントしてください。

**サーバーが中間証明書を送り忘れた。** サーバーが有効なリーフ証明書で構成されていても、信頼されたルートへとつなぐ中間証明書を送らないことがあります。ブラウザは、以前のセッションの中間証明書をキャッシュすることでこれをうまくごまかすことが多いですが、.NET はそうしません。修正はサーバー側にあります。完全なチェーンを送るように構成してください。`openssl s_client -connect host:443 -showcerts` で返される証明書の数を数えて確認できます。

**`RemoteCertificateNotAvailable` を伴う `AuthenticationException`。** サーバーが証明書を送りませんでした。ほぼ間違いなく、`https://` スキームで平の HTTP ポートを指しているか、まだ起動していないサービスを指しています。TLS のコードに触れる前に、ポートとスキームを確認してください。

**これを `TaskCanceledException` と混同しないでください。** ハンドシェイクがハングしてから `HttpClient.Timeout` で打ち切られると、TLS エラーではなくキャンセルとして現れます。症状が検証メッセージではなくタイムアウトであれば、原因と修正は異なります。

## 関連記事

- [解決: HttpClient で TaskCanceledException: A task was canceled](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) は、表面的には遅いハンドシェイクに似ているが根本原因がまったく異なる、タイムアウトの形をした失敗を扱います。
- [HttpClient vs HttpClientFactory vs Refit](/ja/2026/05/httpclient-vs-httpclientfactory-vs-refit/) は、TLS 設定がクライアントの再利用を生き延びるように、カスタムの `SocketsHttpHandler` をどこで構成するかを説明します。
- [HttpClient を使うコードを単体テストする方法](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/) は、上記のエラー分岐を実際の壊れたサーバーなしで動かせるように、トランスポートをフェイクする方法を示します。
- [ASP.NET Core 11 でグローバル例外フィルターを追加する方法](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) は、素っ気ない 500 ではなく内部メッセージを保ったままこの例外を表面化させるのに役立ちます。

## 出典

- [`SslPolicyErrors` enum](https://learn.microsoft.com/en-us/dotnet/api/system.net.security.sslpolicyerrors), Microsoft Learn: 内部メッセージに現れるフラグ (`RemoteCertificateChainErrors`、`RemoteCertificateNameMismatch`、`RemoteCertificateNotAvailable`)。
- [`HttpRequestError` enum](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httprequesterror), Microsoft Learn: .NET 8+ で失敗を分類するために使われる `SecureConnectionError` の値。
- [`SslClientAuthenticationOptions`](https://learn.microsoft.com/en-us/dotnet/api/system.net.security.sslclientauthenticationoptions), Microsoft Learn: `SocketsHttpHandler` 上の `TargetHost`、`EnabledSslProtocols`、`RemoteCertificateValidationCallback`。
- [Enforce TLS in .NET](https://learn.microsoft.com/en-us/dotnet/framework/network-programming/tls), Microsoft Learn: なぜ `SslProtocols.None`（OS がネゴシエート）が推奨される既定値なのか。
- [dotnet/runtime #32498: The SSL connection could not be established](https://github.com/dotnet/runtime/issues/32498): 実際の報告と信頼ストアの診断。
