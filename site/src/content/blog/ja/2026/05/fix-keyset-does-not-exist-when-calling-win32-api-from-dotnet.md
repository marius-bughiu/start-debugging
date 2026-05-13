---
title: "修正: System.Security.Cryptography.CryptographicException: Keyset does not exist"
description: "証明書の秘密鍵は、現在のプロセス ID が読めない別の Windows 鍵ファイルにあります。ACL を設定するか、MachineKeySet で PFX を読み込むか、EphemeralKeySet を使用してください。"
pubDate: 2026-05-13
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "cryptography"
  - "x509"
  - "windows"
lang: "ja"
translationOf: "2026/05/fix-keyset-does-not-exist-when-calling-win32-api-from-dotnet"
translatedBy: "claude"
translationDate: 2026-05-13
---

修正方法: これは Win32 暗号呼び出しから浮上してくる `NTE_BAD_KEYSET` (HRESULT `0x80090016`) です。手元の証明書オブジェクトには公開鍵があるものの、**秘密鍵ファイル**はディスク上の別の場所にあり、現在のプロセス ID にその読み取り権限がないか、実行中のユーザープロファイルに対してそのファイルが存在しません。三つの解決策でほぼ全てのケースをカバーできます。プロセス ID に秘密鍵への読み取りアクセスを付与する (証明書スナップインまたは鍵コンテナファイルへの `icacls`)、PFX を `X509KeyStorageFlags.MachineKeySet | PersistKeySet` で読み込んで鍵をマシンストアに置く、または PFX を `EphemeralKeySet` で読み込んでディスクファイル自体を不要にする、のいずれかです。

```text
System.Security.Cryptography.CryptographicException: Keyset does not exist
   at System.Security.Cryptography.CryptographicException.ThrowCryptographicException(Int32 hr)
   at System.Security.Cryptography.X509Certificates.CertificatePal.GetPrivateKey[T](Func`2 createCsp, Func`2 createCng)
   at System.Security.Cryptography.X509Certificates.X509Certificate2.GetRSAPrivateKey()
   at MyApp.SigningService.Sign(Byte[] payload)
```

本ガイドは Windows Server 2025 / Windows 11 24H2 上の .NET 11 preview 4 を対象に書かれています。このエラーは .NET Framework 1.1 から同一で、メッセージは `winerror.h` の `NTE_BAD_KEYSET` から逐語的に来ています。最新の .NET で変わったのは、PFX を読み込んだときの**鍵保存のデフォルト動作**です。.NET 9 では `X509CertificateLoader` が導入され、PFX 内容向けの `X509Certificate2(byte[])` と `new X509Certificate2(path, password)` コンストラクターは非推奨 (`SYSLIB0057`) となり、推奨される読み込みパスが移動しました。新しい API は古いコンストラクターのようにディスクに鍵をひっそりと永続化**しません**。機械的に一方を他方に置き換えた場合、目にしているエラーはその結果です。

下記のいずれかを適用する前に、二点を確認してください。一つ目、`certificate.HasPrivateKey` は、鍵ファイルが見つからない、あるいはアクセスできない場合でも `true` を返します。このフラグは**証明書のメタデータ**が秘密鍵を表明しているかを追跡しているだけで、実際に開けるかどうかは追跡しません。二つ目、鍵コンテナが存在しない場合、別のユーザープロファイル上にある場合、ACL がプロセスを拒否している場合のいずれでもエラーは同一です。対処はそのどれであるかに依存します。以下のセクションでは順番に追います。

## 証明書になぜ鍵ファイルが必要なのか

Windows では X.509 証明書は公開文書です。対応する秘密鍵が証明書ファイルにあることは決してなく、暗号プロバイダーが管理する鍵コンテナにあります。区別しておくべきプロバイダーが二つ、スコープが二つあります。

- **CAPI (Microsoft Cryptographic API)**: レガシープロバイダー。鍵コンテナはユーザースコープでは `%APPDATA%\Microsoft\Crypto\RSA\<SID>\` に、マシンスコープでは `%ProgramData%\Microsoft\Crypto\RSA\MachineKeys\` に保存されます。各コンテナは GUID のような名前を持つ単一ファイルです。
- **CNG (Cryptography Next Generation)**: 最新プロバイダー。鍵コンテナはそれぞれ `%APPDATA%\Microsoft\Crypto\Keys\` と `%ProgramData%\Microsoft\Crypto\Keys\` にあります。

PFX をインポートすると、ローダーは証明書を**個人**証明書ストア (`Cert:\CurrentUser\My` または `Cert:\LocalMachine\My`) に書き込み、鍵のマテリアルは `X509KeyStorageFlags` に応じて上記四ディレクトリのいずれかに書き込みます。ストアから証明書を取り出して `X509Certificate2` に入れる時点では、公開部分と鍵コンテナへのポインターだけが取得されます。`GetRSAPrivateKey()`、`GetECDsaPrivateKey()`、または非推奨の `PrivateKey` プロパティを最初に呼び出した瞬間に、ランタイムは対応する Win32 API 経由でそのコンテナを開きます。ファイルが消えている、SID に読み取り ACE がない、あるいはパスが現在のログオンセッションに存在しないプロファイルに解決される場合、`NTE_BAD_KEYSET` が出ます。

要点は、証明書と鍵は疎結合であり、「このプロセスは秘密鍵を持っているか」という問いは実際には「このプロセス ID は、この証明書から参照されるファイルへの読み取りアクセスを持っているか」だということです。以下の各修正は、その問いに別々の方法で答えます。

## 最小再現

.NET 9 以降のローダーに切り替えた後にエラーを再現する最短のプログラム:

```csharp
// .NET 11 preview 4, Windows 11 24H2
using System.Security.Cryptography.X509Certificates;

var bytes = File.ReadAllBytes("signing.pfx");
var cert = X509CertificateLoader.LoadPkcs12(bytes, password: "test");

using var rsa = cert.GetRSAPrivateKey();
var signature = rsa!.SignData("hello"u8.ToArray(), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
```

これをインタラクティブなデスクトップセッションから実行すると動きます。同じバイナリを `NT SERVICE\MyService` として Windows サービスから、または `LoadUserProfile = false` の IIS アプリケーションプールから実行すると、`GetRSAPrivateKey()` は "Keyset does not exist" をスローします。PFX は問題なく読み込まれました。証明書オブジェクトは構築されました。クラッシュは、秘密鍵に手を伸ばしたまさにその瞬間に発生します。

理由: `X509CertificateLoader.LoadPkcs12` のデフォルトは `X509KeyStorageFlags.DefaultKeySet` で、Windows では**ユーザー**鍵ストアを意味します。ユーザープロファイルが読み込まれていないサービス ID には書き込み先の `%APPDATA%\Microsoft\Crypto\...` がないため、鍵ファイルは次回呼び出し時に到達不可能な一時的な場所に作成されるか、まったく作成されません。

## 修正 1: 現在の ID に鍵への読み取りアクセスを付与する

これは、証明書がすでにマシンストアに導入されており、インポートコードを制御できない (運用管理されたサーバーで典型的) 場合に正しい修正です。`certlm.msc` (LocalMachine) または `certmgr.msc` (CurrentUser) を開き、**個人 > 証明書**で証明書を見つけ、右クリック、**すべてのタスク > 秘密キーの管理**で、**読み取り**権限とともにプロセス ID を追加します。

IIS アプリケーションプール用に PowerShell でスクリプト化された同じ操作:

```powershell
# Windows 11 24H2 / Windows Server 2025, PowerShell 7.5
$cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object Thumbprint -eq 'AABBCC...'
$keyFile = $cert.PrivateKey.Key.UniqueName  # CNG

$keyPath = Join-Path $env:ProgramData "Microsoft\Crypto\Keys\$keyFile"
$acl = Get-Acl $keyPath
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    'IIS APPPOOL\MyAppPool', 'Read', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl $keyPath $acl
```

CAPI 証明書では `Crypto\Keys` を `Crypto\RSA\MachineKeys` に置き換え、代わりに `cert.PrivateKey.CspKeyContainerInfo.UniqueKeyContainerName` を読みます。コマンドレット名 `Get-PfxCertificate` はここで魅力的に見えますが、生きているストア証明書は返しません。`PrivateKey` プロパティがディスク上のコンテナを指すよう、`Get-ChildItem Cert:\...` を使ってください。

`NT SERVICE\<ServiceName>` で動く Windows サービスでは SID は仮想で、`icacls` で付与します:

```powershell
icacls $keyPath /grant "NT SERVICE\MyService:R"
```

自分のプロセスがどの SID で動いているか分からない場合、その ID として起動したコマンドプロンプトから `whoami /user` を実行すれば出力されます。コンテナ化された Windows サービスでは、`nt authority\system` と `nt authority\network service` がよく登場します。

## 修正 2: 正しい鍵保存フラグで PFX を読み込む

これは、アプリケーションが証明書ファイルを所有し、起動時に読み込む場合の正しい修正です。`DefaultKeySet` への依存をやめ、明示的にしましょう:

```csharp
// .NET 11 preview 4, long-running service that needs the key to survive restarts
var cert = X509CertificateLoader.LoadPkcs12FromFile(
    "signing.pfx",
    password: "test",
    keyStorageFlags: X509KeyStorageFlags.MachineKeySet
                   | X509KeyStorageFlags.PersistKeySet
                   | X509KeyStorageFlags.Exportable);
```

`MachineKeySet` は鍵を `%ProgramData%\Microsoft\Crypto\Keys` (CNG) に、サービス ID が読める ACL の下に書き込みます。`PersistKeySet` は `X509Certificate2` が破棄された後もファイルをディスクに残します。これを付けない場合、.NET Framework 4.7.2 以降のデフォルトは、証明書オブジェクトがスコープから外れた瞬間に鍵を削除することで、同じコードパスの**二回目**の呼び出しで "Keyset does not exist" を発生させます。`Exportable` は任意で、後で `ExportPkcs8PrivateKey` を呼んだり、鍵を別のストアに書き込んだりする場合にのみ必要です。注意: `PersistKeySet` と `EphemeralKeySet` は相互排他で、両方を渡すと `X509CertificateLoader` から `CryptographicException` がスローされます。

ホストされた .NET 11 アプリで、鍵をプロセス内でしか必要とせず、ディスクファイルを絶対に作りたくない場合は `EphemeralKeySet` を使い、永続化の問題を完全に飛ばしましょう:

```csharp
// .NET 11 preview 4, ASP.NET Core minimal API loading a cert from configuration
var cert = X509CertificateLoader.LoadPkcs12FromFile(
    path,
    password,
    keyStorageFlags: X509KeyStorageFlags.EphemeralKeySet);
```

`EphemeralKeySet` はコンテナ、スケール to ゼロのワークロード、ユーザープロファイルが欠落・再生成されうるあらゆる環境において最も堅牢な選択です。鍵は `X509Certificate2` インスタンス内にのみ存在し、破棄すれば鍵は消えます。トレードオフは、その後に証明書を Windows ストアにインポートできない点と、4.7.2 以前の .NET Framework / 2.0 以前の .NET Core ではフラグが存在しなかった点です。Linux と macOS では Windows の鍵ファイルがそもそも存在しないので no-op です。

## 修正 3: IIS アプリケーションプールと Windows サービスの ID にまつわるクセ

IIS アプリケーションプールは、このエラーの最も多い単一の発生源です。秘密鍵の検索が動くかどうかは二つの設定が決めます:

- **ユーザープロファイルの読み込み**: `applicationHost.config` または IIS マネージャーのアプリケーションプール**詳細設定**で**ユーザープロファイルの読み込み**を `True` にします。これがないと、`IIS APPPOOL\MyAppPool` ID には `%APPDATA%` がなく、`UserKeySet` や `DefaultKeySet` にデフォルトで落ちるコードパスは二回目の呼び出しで失敗します。
- **プロセスモデル > ID**: `ApplicationPoolIdentity` のままにし、仮想 SID `IIS APPPOOL\MyAppPool` に鍵ファイルへの読み取りアクセスを付与してください (修正 1)。これを「回避」するためにアプリケーションプールを `LocalSystem` で動かしてはいけません。それは本物の権限昇格であって修正ではありません。

[.NET 11 のホストサービステンプレート](/ja/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) と `Microsoft.Extensions.Hosting.WindowsServices` で書かれた Windows サービスでは、相当する設定はサービスを独自の仮想アカウントで登録することです:

```powershell
sc.exe create MyService binPath= "C:\svc\MyService.exe" obj= "NT SERVICE\MyService" start= auto
icacls "C:\ProgramData\Microsoft\Crypto\Keys\<keyfile>" /grant "NT SERVICE\MyService:R"
```

アプリケーションプールと同じ理由で、サービスを `LocalSystem` で動かすのは避けてください。ホスト上の他のすべてのマシン鍵への読み取りをうっかり付与することになります。最小権限の原則はファイルパスと同様に暗号コンテナにも当てはまります。

## 修正 4: Azure App Service、Azure Functions、コンテナ

クラウドホストは、下層のファイルシステムが自分のものではないため、この問題の鋭利なバージョンに当たります。プラットフォーム別の三つのつまみ:

- **Azure App Service**: PFX/PEM を **TLS/SSL settings > Private Key Certificates** にアップロードし、アプリケーション設定 `WEBSITE_LOAD_CERTIFICATES` を `*` か証明書の thumbprint に設定します。App Service のサンドボックスは、その変数で thumbprint が許可されないかぎり秘密鍵の読み込みを拒否します。これなしでは `GetRSAPrivateKey()` を呼んだ瞬間に "Keyset does not exist" が出ます。設定 `WEBSITE_LOAD_USER_PROFILE = 1` は IIS の**ユーザープロファイルの読み込み**の App Service 相当で、コードパスがユーザー鍵に解決される場合に必要です。
- **Azure Functions (Windows consumption / Premium)**: 同じ `WEBSITE_LOAD_CERTIFICATES` の要件があります。isolated worker 関数では、`D:\home\site\wwwroot` から PFX を読むのではなく `cert:\CurrentUser\My` から証明書を読み込むことを優先してください。PFX パスは読み取り専用で、`PersistKeySet` は黙って失敗します。
- **Linux コンテナ (Linux App Service プランや AKS を含む)**: Windows の鍵ファイルがないため、`EphemeralKeySet` 以外の `X509KeyStorageFlags` は事実上無視されます。`dotnet publish` のイメージで見るエラーは "Keyset does not exist" ではなく、`CspParameters` や `PrivateKey = ...` セッターに手を伸ばすと `PlatformNotSupportedException` です。最新の `CopyWithPrivateKey` API と `EphemeralKeySet` を使えばコードは可搬になります。

[.NET 11 AWS Lambda 関数](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) でも Linux コンテナと同じロジックが当てはまります。Windows の鍵ストアはなく、PFX は Lambda Layer または Secrets Manager から `EphemeralKeySet` で読み込みます。呼び出しのあいだの `/tmp` からは決して読まないでください。サンドボックスはコールドスタートをまたいで `/tmp` が残ることを保証しません。

## 修正 5: `PrivateKey` ではなく最新の API で鍵を読む

`X509Certificate2.PrivateKey` プロパティは .NET 11 でもまだ存在しますが非推奨です (セッターは `SYSLIB0028`、EC 鍵に対するゲッターは `SYSLIB0058`)。これは `AsymmetricAlgorithm` を返しますが、内部で CAPI を呼び、証明書が CNG としてインポートされていてもそうです。鍵コンテナが欠落しているときに最も確実に "Keyset does not exist" をスローするのは、その CAPI シム層です。最新のアクセサーはファイルを開く前に追加のチェックを行い、より明快な例外を露出します:

```csharp
// .NET 11 preview 4
using var rsa = cert.GetRSAPrivateKey();
using var ecdsa = cert.GetECDsaPrivateKey();
using var dsa = cert.GetDSAPrivateKey();
```

`HasPrivateKey` が `true` でも `GetRSAPrivateKey()` が `null` を返す場合、証明書は非 RSA アルゴリズムを使用しています。代わりに `GetECDsaPrivateKey()` を試してください。`GetRSAPrivateKey()` が "Keyset does not exist" をスローする場合、メタデータは鍵が存在すると主張しているがファイルが存在しないという状況であり、修正 1 から 4 のいずれかが当てはまります。

## 落とし穴と類似ケース

- **`X509CertificateLoader` は .NET 11 ではオプションではありません。** 古い `new X509Certificate2(path, password)` コンストラクターは `SYSLIB0057` でフラグ付けされ、将来のリリースで削除されます。今のうちに移行し、`X509KeyStorageFlags` の選択を再考してください。ローダーのデフォルトはより厳格です。
- **`HasPrivateKey` は嘘をつきます。** これは証明書の `keyUsage` 拡張と `CERT_KEY_PROV_INFO_PROP_ID` の存在をチェックするだけで、`Crypto\Keys` 配下のファイルが正常に開けるかは見ません。実際に鍵を取得して `CryptographicException` をキャッチし、「鍵なし」として扱うのが正解で、`HasPrivateKey` で分岐するべきではありません。
- **「Access is denied」は親類エラーです。** 根本原因は同じ (ACL の欠落) で、コードパスが違うだけです。レガシー CAPI は `NTE_BAD_KEYSET` を返し、最新の CNG は時に `0x80090010 NTE_PERM` を返して `CryptographicException: Access is denied` として現れます。修正は同一で、検索ヒットだけが違います。
- **PFX は問題ない。ストア参照が古い。** PFX をインポートし、`Cert:\LocalMachine\My` から削除し、再インポートした場合、証明書メタデータ内の鍵ファイルパスが古い (削除済み) コンテナを指していることがあります。エクスポートし、完全に削除し (`Remove-Item Cert:\LocalMachine\My\<thumbprint>` プラス `certutil -delstore`)、再インポートしてください。
- **`SqlClient` と `X509Chain.Build()` は同じ例外をスローします。** 両方ともチェーンを検証したり接続文字列に署名したりするときに `GetRSAPrivateKey()` を裏で呼びます。このメッセージで証明書認証に失敗する SQL 接続は、それで失敗する JWT 署名と同じバグです。[`SqlException: Timeout expired` の失敗モード](/ja/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) は別件です。
- **CryptoAPI と CNG のミスマッチ。** CAPI 生成の PFX を CNG 経由でインポート (またはその逆) すると、鍵が一方のプロバイダーに、メタデータがもう一方を指す状態で残ることがあります。`certutil -repairstore My <thumbprint>` で再インポートなしにリンクを再構築できます。
- **ユーザープロファイルが読み込まれていません。** タスクスケジューラ、`LoadUserProfile` のない IIS アプリケーションプール、`ContainerUser` として動く Windows Docker コンテナにはこの特徴が共通します。プロファイル設定を有効にするか、マシン鍵に切り替えるか、`EphemeralKeySet` を使うかのいずれかです。

## 関連

- [修正: System.IO.FileNotFoundException: Could not load file or assembly](/ja/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) は「自分のマシンでは動く」系のデプロイエラーのうち、鍵ではなくバイナリが原因の場合をカバーします。
- [修正: Native AOT での PlatformNotSupportedException](/ja/2026/05/fix-platformnotsupportedexception-in-native-aot/) は、Native AOT アプリを発行し `new RSACryptoServiceProvider()` を直接呼んだときに見るものです。AOT コンパイラは CAPI シムを完全にトリムします。
- [ASP.NET Core Identity でリフレッシュトークンを実装する方法](/ja/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) は、秘密鍵を読み込む最も一般的な理由 (ホストされた ID プロバイダーで JWT に署名する) 周りの配線を示します。
- [.NET 11 AWS Lambda のコールドスタート時間を短縮する方法](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) はサーバーレス環境での証明書読み込みを論じます。そこでは `EphemeralKeySet` が正しい挙動をする唯一の鍵保存フラグです。
- [.NET 11 で Serilog と Seq による構造化ログ出力をセットアップする方法](/ja/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) は、本番サービスで鍵アクセスが失敗する瞬間を追跡するのに役立ちます。`X509Certificate2` の操作はデフォルトで何もログを出しません。

## 情報源

- [`X509KeyStorageFlags` Enum, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.x509keystorageflags)
- [`X509CertificateLoader` class, .NET 9+, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.x509certificateloader)
- [`SYSLIB0057`: Obsolete X509Certificate2 PFX constructors](https://learn.microsoft.com/en-us/dotnet/fundamentals/syslib-diagnostics/syslib0057)
- [Private Key Lifetime on Windows, January 2021 .NET Framework rollup, Microsoft Support](https://support.microsoft.com/en-us/topic/private-key-lifetime-on-windows-and-the-january-2021-net-framework-security-and-quality-rollup-3f097a10-f798-4ffd-8511-4757ebaf2c70)
- [`dotnet/runtime` issue 67752: occasional "Keyset does not exist" with `GetRSAPrivateKey` on Windows](https://github.com/dotnet/runtime/issues/67752)
- [`dotnet/aspnetcore` issue 3218: Data Protection "Keyset does not exist" even with PrivateKey set programmatically](https://github.com/dotnet/aspnetcore/issues/3218)
- [Load certificates in Azure App Service, MS Learn](https://learn.microsoft.com/en-us/azure/app-service/configure-ssl-certificate-in-code)
