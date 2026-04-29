---
title: "オープンソースの WPF SSH マネージャーが見せる実践的パターン: WebView2 上の xterm.js、シークレットは DPAPI で"
description: "SshManager は .NET 8 上に構築されたオープンソースの WPF SSH マネージャーです。実践的なパターンを示します: ターミナル描画は WebView2 内の xterm.js、永続化は EF Core + SQLite、ローカル認証情報の保護は DPAPI。"
pubDate: 2026-01-18
tags:
  - "dotnet"
  - "dotnet-8"
  - "webview2"
  - "wpf"
lang: "ja"
translationOf: "2026/01/an-open-source-wpf-ssh-manager-shows-a-practical-pattern-xterm-js-in-webview2-secrets-via-dpapi"
translatedBy: "claude"
translationDate: 2026-04-29
---
今日 r/csharp で気の利いた Windows デスクトッププロジェクトが出てきました: **SshManager** は、**.NET 8** と **WPF** で構築されたオープンソースの SSH およびシリアルマネージャーです。

ソース: Reddit の元投稿とリポジトリ: [r/csharp スレッド](https://www.reddit.com/r/csharp/comments/1qgf6e1/i_built_an_opensource_ssh_manager_for_windows/) と [tomertec/sshmanager](https://github.com/tomertec/sshmanager)。

## 興味深いのは「C# で SSH」ではない

SSH 自体は解決済みです。学ぶ価値があるのは、このアプリが 3 つのとても実用的なピースをどう縫い合わせているかです:

-   **本物のターミナル UI**: **WebView2** 内で xterm.js をレンダリングするので、WPF でターミナルコントロールを再発明しようとせずに、ターミナル UX (コピー、選択、等幅レンダリング) が手に入ります。
-   **ローカル永続化**: 接続プロファイル、タグ、セッションメタデータに EF Core + SQLite。
-   **Windows ネイティブのシークレット保護**: パスワードを **Windows DPAPI** で暗号化。これはローカル専用のデスクトップツールにまさに望ましい形です。

このパターンが好きなのは、「難しい UX 問題」(ターミナルレンダリング) を実績のある web コンポーネントの内側に閉じ込めつつ、残りは慣用的な .NET 8 のままにしているからです。

## DPAPI はローカル限定の認証情報のよいデフォルト

DPAPI はマシンをまたぐ暗号化ではありません。現在の Windows ユーザープロファイル (またはスコープによってはマシン) に紐付きます。シングルユーザーのデスクトップアプリにとってはそれが利点です。

.NET 8 の WPF アプリに取り込める最小の「protect/unprotect」ヘルパーは次のとおりです:

```cs
using System.Security.Cryptography;
using System.Text;

static class Dpapi
{
    public static string ProtectToBase64(string plaintext)
    {
        var bytes = Encoding.UTF8.GetBytes(plaintext);
        var protectedBytes = ProtectedData.Protect(
            bytes,
            optionalEntropy: null,
            scope: DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(protectedBytes);
    }

    public static string UnprotectFromBase64(string base64)
    {
        var protectedBytes = Convert.FromBase64String(base64);
        var bytes = ProtectedData.Unprotect(
            protectedBytes,
            optionalEntropy: null,
            scope: DataProtectionScope.CurrentUser);
        return Encoding.UTF8.GetString(bytes);
    }
}
```

後から「設定をデバイス間で同期」を追加するなら、DPAPI は適切なツールではなくなり、別の鍵管理戦略が必要になります。Windows ファースト、ローカル専用のマネージャーには、DPAPI はちょうどよい退屈さの度合いです。

## ターミナル向けには WebView2 + xterm.js が「WPF と戦うのをやめる」選択肢

.NET 8 で社内ツールを作っていて、UI が本物のターミナル (vim、tmux、htop) のように振る舞う必要があるなら、WebView2 内に xterm.js を埋め込むのは驚くほどきれいな境界です:

-   WPF はウィンドウとアプリのライフサイクルを所有します。
-   web 側はターミナルレンダリングとキーボードの振る舞いを所有します。
-   橋渡しは単なるメッセージです: PTY にバイトを書き込み、出力を読み、戻す。

おもちゃではない例が欲しいなら、このリポジトリは目を通す価値があります。接続モデルとターミナルビューの配線から見始め、自分のツール作りにこのハイブリッドアプローチが合うか判断してください。
