---
title: "C# アプリで Windows セッションのロック、ロック解除、ログオン、ログオフのイベントを検出する方法"
description: "デスクトップアプリやコンソールアプリでは SystemEvents.SessionSwitch を使い、Windows サービスでは OnSessionChange をオーバーライドし、あるいは WM_WTSSESSION_CHANGE を自分でフックします。3 つすべての .NET 10 コード、隠れた '.NET System Events' スレッド、サービスではログオンが見えるのにデスクトップアプリでは見えない理由、順序が入れ替わる通知、WTSQuerySessionInformation で現在のロック状態を問い合わせる方法を解説します。"
pubDate: 2026-10-04
template: how-to
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "windows"
  - "worker-service"
  - "how-to"
lang: "ja"
translationOf: "2026/10/how-to-detect-windows-session-lock-unlock-logon-and-logoff-events-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-04
---

結論から言うと、ユーザーのセッション内で動作するプロセス (WinForms、WPF、または普通のコンソールアプリ) では、`Microsoft.Win32.SystemEvents.SessionSwitch` を購読して `e.Reason` で分岐します。値は `SessionLock`、`SessionUnlock`、`SessionLogon`、`SessionLogoff` に加えて、コンソールおよびリモートの接続/切断の値です。Windows サービスでは `CanHandleSessionChangeEvent = true` を設定して `ServiceBase.OnSessionChange` をオーバーライドします。.NET の汎用ホストでは、これは `WindowsServiceLifetime` をサブクラス化することを意味します。どちらも同じ Win32 通知 `WM_WTSSESSION_CHANGE` の薄いラッパーであり、この通知はウィンドウプロシージャから直接フックすることもできます。イベントを待つのではなく "いまセッションはロックされているか?" を問い合わせるには、`WTSSessionInfoEx` を指定して `WTSQuerySessionInformation` を呼び出します。

この記事のコードは .NET 10 (SDK 10.0.302) を対象とし、`Microsoft.Win32.SystemEvents` 10.0.12 と `Microsoft.Extensions.Hosting.WindowsServices` 10.0.12 を使用しています。すべてのスニペットは `net10.0-windows` に対してコンパイル確認済みで、スレッドに関する挙動の説明はこれらのパッケージの `dotnet/runtime` のソースに基づいています (リンクは記事末尾にあります)。基盤となる API は Windows Vista 以降変わっていないため、同じ手法は .NET 8、.NET 9、.NET 11 RC でも機能します。

## どの API がどのイベントを受け取るか

Windows はセッション状態の変化ごとに 1 つの通知を発行し、マネージド API はいずれもそれを受け取る方法の違いにすぎません。値はどこでも同じなので、複数の手法を組み合わせるときに役立ちます。

| 値 | `SessionSwitchReason` / `SessionChangeReason` | 意味 |
|---|---|---|
| 1 | `ConsoleConnect` | セッションが物理コンソールに接続された |
| 2 | `ConsoleDisconnect` | セッションがコンソールから切断された (ユーザーの簡易切り替え) |
| 3 | `RemoteConnect` | セッションが Remote Desktop 経由で接続された |
| 4 | `RemoteDisconnect` | Remote Desktop クライアントが切断された |
| 5 | `SessionLogon` | ユーザーがログオンした |
| 6 | `SessionLogoff` | ユーザーがログオフした |
| 7 | `SessionLock` | セッションがロックされた |
| 8 | `SessionUnlock` | セッションのロックが解除された |
| 9 | `SessionRemoteControl` | リモート制御の状態が変化した |

重要な違いは値ではなく、*誰が* それを受け取るかです。`NOTIFY_FOR_THIS_SESSION` で登録されたウィンドウは自分自身のセッションの通知しか受け取りません。Windows サービスはセッション 0 で動作し、マシン上のすべてのセッションの通知を受け取ります。ここから、多くの人が繰り返しつまずく結果が生じます。**デスクトップアプリは自分自身の `SessionLogon` を決して受け取りません**。ログオンが起きた後に起動されるからです。また自分自身の `SessionLogoff` もほとんど受け取りません。その瞬間に終了処理が進んでいるからです。本当に必要なのが "ログオン" と "ログオフ" であれば、サービスを使うか、ログオフ側については `SystemEvents.SessionEnding` を使います。ロックとロック解除はどちらからでも問題なく受け取れます。

## デスクトップアプリとコンソールアプリ: SystemEvents.SessionSwitch

WinForms と WPF では、`Microsoft.Win32.SystemEvents` はすでに Windows Desktop 共有フレームワークに含まれています。コンソールアプリやライブラリでは、パッケージを追加します。

```xml
<!-- SessionWatch.csproj, .NET 10 SDK -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0-windows</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.Win32.SystemEvents" Version="10.0.12" />
  </ItemGroup>
</Project>
```

`-windows` TFM は厳密には必須ではありません。パッケージには普通の `net10.0` アセンブリも含まれています。Linux と macOS ではそのアセンブリは `PlatformNotSupportedException` をスローするスタブなので、`net10.0-windows` を対象にすることで、実行時の思わぬエラーを呼び出し箇所での CA1416 アナライザー警告に変えられます。`AllowUnsafeBlocks` は記事後半の `LibraryImport` のコードでのみ必要です。

イベント自体は数行で済みます。

```csharp
// .NET 10, C# 14, Microsoft.Win32.SystemEvents 10.0.12
using Microsoft.Win32;

Console.WriteLine($"Locked right now: {SessionState.IsLocked()}");

SessionSwitchEventHandler onSwitch = (_, e) =>
{
    // Runs on the ".NET System Events" thread, not the main thread.
    Console.WriteLine($"{DateTime.Now:HH:mm:ss} {e.Reason} (thread: {Thread.CurrentThread.Name})");
};

SessionEndedEventHandler onEnded = (_, e) =>
    Console.WriteLine($"{DateTime.Now:HH:mm:ss} session ending: {e.Reason}");

SystemEvents.SessionSwitch += onSwitch;
SystemEvents.SessionEnded += onEnded;

try
{
    Console.WriteLine("Lock the workstation (Win+L), then unlock. Press Enter to quit.");
    Console.ReadLine();
}
finally
{
    // Static events root your handler (and everything it captures) forever.
    SystemEvents.SessionSwitch -= onSwitch;
    SystemEvents.SessionEnded -= onEnded;
}
```

Win+L を押してロックを解除すると、`SessionLock` に続いて `SessionUnlock` が届きます。ユーザーの簡易切り替えでユーザーを切り替えると、離れるときに `ConsoleDisconnect`、戻ってきたときに `ConsoleConnect` が届き、通常はロックとロック解除も一緒に届きます。同じユーザーで RDP 接続すると、そのセッションは `ConsoleDisconnect` に続いて `RemoteConnect` を報告します。

### メッセージポンプはどこから来るのか

このトピックに関する古い回答では、`SessionSwitch` は "メッセージループがある場合にしか機能しない" とされており、MS Learn のこのイベントのページにも今なおその注記があります。最新の .NET では、それは半分しか正しくありません。.NET 6 以降 (dotnet/runtime PR #53467, "Always spawn message loop thread for SystemEvents")、いずれかの `SystemEvents` イベントへの最初の購読によって、`.NET System Events` という名前の専用バックグラウンドスレッド上に隠れた `WS_POPUP` ウィンドウが作成され、そのスレッドで `GetMessage`/`DispatchMessage` が実行されます。ソースのコメントは明確で、呼び出し元のスレッドが STA であっても常に独自のスレッドを作成します。そのスレッドがメッセージを処理し続ける保証がないからです。そのため、UI を持たないコンソールアプリでも追加の作業なしでイベントを受け取れます。

特に `SessionSwitch` を購読すると、その隠れたウィンドウに対して `WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)` も呼び出されます。"このセッションのみ" というスコープはここから来ています。

### ハンドラーはどのスレッドで実行されるか

購読時に `SystemEvents` は `AsyncOperationManager.SynchronizationContext` をキャプチャし、後でそれに対して `Send` を呼び出します。

- WinForms や WPF では、UI スレッドから購読すると UI コンテキストがキャプチャされるため、ハンドラーは UI スレッドにマーシャリングされます。コントロールに直接触れられます。
- コンソールアプリやワーカーではコンテキストがないため、キャプチャされるのは `Send` をインラインで実行する素の `SynchronizationContext` です。ハンドラーは `.NET System Events` スレッド上で実行されます。

2 つ目のケースが重要です。そのスレッドは `PowerModeChanged`、`UserPreferenceChanged`、`DisplaySettingsChanged` などのディスパッチも担当しています。ロックのハンドラーがブロッキングする HTTP 呼び出しを行ったりロックを待機したりすると、プロセス内の他のすべてのシステムイベントも待たされます。作業はすぐに引き渡してください。たとえば `Channel<T>` ([BlockingCollection の代わりにチャネルを使う](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) パターンがここにぴったり合います) や `Task.Run` に渡します。

### 静的イベントによるリーク

`SessionSwitch` は静的イベントです。`this` をキャプチャするハンドラーは、購読を解除するまでオブジェクトグラフ全体を生かし続けます。閉じた WPF ウィンドウがプロセスの存続期間中ずっと残ってしまう典型的なパターンです。MS Learn の解説でも明示的に警告されています。`Dispose`、`OnClosed`、または `finally` で購読を解除してください。破棄されないウィンドウを追いかけている場合は、[`dotnet-gcdump` による比較](/ja/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) で `SystemEvents` がそれを保持していることがわかります。

## Windows サービス: OnSessionChange と汎用ホスト

サービスでは `SystemEvents.SessionSwitch` を有効に使えません。サービスはセッション 0 で動作するため、`NOTIFY_FOR_THIS_SESSION` によって隠れたウィンドウのスコープがセッション 0 に限定されますが、そこでは誰もロックもロック解除もしません。`WTSRegisterSessionNotification` のドキュメントにははっきり書かれています。サービスはこれらの通知をウィンドウではなく、サービスコントロールハンドラー (`SERVICE_CONTROL_SESSIONCHANGE` を伴う `HandlerEx`) を通じて受け取ります。

`System.ServiceProcess.ServiceBase` はすでにその配線を行っています。`CanHandleSessionChangeEvent = true` でオプトインし、`OnSessionChange(SessionChangeDescription)` をオーバーライドすると、影響を受けたセッションの `Reason` と `SessionId` を受け取れます。最新のワーカーサービスでは、`ServiceBase` は `WindowsServiceLifetime` の内部に隠れていますが、このクラスは public で sealed ではありません。最もすっきりした方法は、これをサブクラス化して、そのサブクラスを `IHostLifetime` として登録することです。

1. `Microsoft.Extensions.Hosting.WindowsServices` を参照し、通常どおり `AddWindowsService()` を呼び出します。
2. `WindowsServiceLifetime` をサブクラス化し、コンストラクターで `CanHandleSessionChangeEvent = true` を設定して、`OnSessionChange` をオーバーライドします。
3. サービスとして実行している場合にのみ、`AddWindowsService` の *後に* サブクラスを `IHostLifetime` として登録し、最後の登録が優先されるようにします。
4. 各通知をチャネルに送り、`BackgroundService` で処理します。

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Hosting.WindowsServices 10.0.12
using System.ServiceProcess;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Options;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(o => o.ServiceName = "SessionAudit");

var sessionEvents = Channel.CreateUnbounded<SessionChangeDescription>();
builder.Services.AddSingleton(sessionEvents);

if (WindowsServiceHelpers.IsWindowsService())
{
    // Registered after AddWindowsService, so this one wins when IHostLifetime is resolved.
    builder.Services.AddSingleton<IHostLifetime, SessionAwareLifetime>();
}

builder.Services.AddHostedService<SessionAuditWorker>();
builder.Build().Run();

sealed class SessionAwareLifetime : WindowsServiceLifetime
{
    private readonly ChannelWriter<SessionChangeDescription> _writer;

    public SessionAwareLifetime(
        IHostEnvironment environment,
        IHostApplicationLifetime applicationLifetime,
        ILoggerFactory loggerFactory,
        IOptions<HostOptions> hostOptions,
        IOptions<WindowsServiceLifetimeOptions> serviceOptions,
        Channel<SessionChangeDescription> channel)
        : base(environment, applicationLifetime, loggerFactory, hostOptions, serviceOptions)
    {
        // Must be set before the SCM starts the service, or it throws.
        CanHandleSessionChangeEvent = true;
        _writer = channel.Writer;
    }

    protected override void OnSessionChange(SessionChangeDescription changeDescription)
    {
        // Keep this fast: hand off and return to the SCM dispatcher.
        _writer.TryWrite(changeDescription);
        base.OnSessionChange(changeDescription);
    }
}

sealed class SessionAuditWorker(
    Channel<SessionChangeDescription> channel,
    ILogger<SessionAuditWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var change in channel.Reader.ReadAllAsync(stoppingToken))
        {
            logger.LogInformation("Session {SessionId}: {Reason}", change.SessionId, change.Reason);
        }
    }
}
```

コンストラクターが重要です。`CanHandleSessionChangeEvent` は、サービス開始時に Service Control Manager に報告される受け入れ可能なコントロールに `SERVICE_ACCEPT_SESSIONCHANGE` を追加します。また、サービスの実行中にこのセッターを呼ぶと `InvalidOperationException` がスローされます。`WindowsServiceLifetime` は `WaitForStartAsync` からしか `ServiceBase.Run` を呼び出さないため、コンストラクターでの設定で十分間に合います。

`IsWindowsService()` のガードによって `dotnet run` が引き続き機能します。SCM の外では `AddWindowsService` は何も登録せず、コンソールからデバッグするときに `ServiceBase` のライフタイムは不要だからです。`IHostLifetime` と `BackgroundService` の分担が初めての場合は、[IHostedService の契約に関する記事](/ja/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/) で、ホストが何をいつ呼び出すかを解説しています。

デスクトップアプリと違って、このサービスはすべてのユーザーを把握できます。起動時のログオン、ログオフ、各セッションでのロックとロック解除、RDP 接続です。そのため "このマシンにユーザーがいつログオンしたかを追跡する" や "誰かがロックアウトされている間はジョブを一時停止する" といった用途に適したツールです。

### 通知は順序が入れ替わって届くことがある

`ServiceBase` は SCM のディスパッチャースレッド上で `OnSessionChange` を呼び出しません。各 `SERVICE_CONTROL_SESSIONCHANGE` は `ThreadPool.QueueUserWorkItem` でキューに入れられるため、近いタイミングで届いた 2 つの通知 (ロックの直後のロック解除や、同じ操作による `SessionLogoff` と `ConsoleDisconnect`) は異なるスレッドプールのスレッドで実行され、同時に実行されたり順序が入れ替わったりする可能性があります。上記のチャネルが保持するのは `TryWrite` の呼び出し順であり、Windows が送信した順序ではありません。

ロジックにとって順序が重要な場合は、イベントをヒントとして扱い、実際の状態を読み直してください。イベントを処理するときに `WTSQuerySessionInformation` (次のセクション) でセッションを問い合わせ、理由コードだけでなく返ってきた結果に基づいて動作します。

### セッション ID からユーザー名を取得する

`SessionChangeDescription` が持っているのは番号だけです。*誰が* ロックやログオンをしたかをログに記録するには、以下と同じ P/Invoke パターンを使い、`WTSQuerySessionInformation(..., WTSUserName)` と `WTSDomainName` でセッションのユーザー名とドメインを問い合わせます。これは速やかに行ってください。`SessionLogoff` の後はセッションの終了処理が進んでおり、クエリが空文字列を返すことがあります。

## 現在のロック状態を問い合わせる

イベントが教えてくれるのは状態の遷移です。起動時には現在の状態が必要です。アプリの起動時にセッションがすでにロックされていたことは、誰も教えてくれないからです。`WTSSessionInfoEx` クラスを指定した `WTSQuerySessionInformation` は `WTSINFOEXW` を返し、その `SessionFlags` フィールドには `WTS_SESSIONSTATE_LOCK` (0) または `WTS_SESSIONSTATE_UNLOCK` (1) が入っています。

```csharp
// .NET 10, C# 14
using System.Runtime.InteropServices;

static partial class SessionState
{
    private const int WTSSessionInfoEx = 25;
    private const int WTS_SESSIONSTATE_LOCK = 0;
    private const int WTS_SESSIONSTATE_UNLOCK = 1;
    private static readonly nint WTS_CURRENT_SERVER_HANDLE = 0;
    private const int WTS_CURRENT_SESSION = -1;

    [LibraryImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool WTSQuerySessionInformation(
        nint hServer, int sessionId, int infoClass, out nint buffer, out int bytesReturned);

    [LibraryImport("wtsapi32.dll")]
    private static partial void WTSFreeMemory(nint memory);

    [LibraryImport("kernel32.dll")]
    private static partial int WTSGetActiveConsoleSessionId();

    /// <summary>Returns true if locked, false if unlocked, null if Windows does not know.</summary>
    public static bool? IsLocked(int sessionId = WTS_CURRENT_SESSION)
    {
        if (!WTSQuerySessionInformation(WTS_CURRENT_SERVER_HANDLE, sessionId, WTSSessionInfoEx,
                out nint buffer, out _))
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastPInvokeError());
        }

        try
        {
            // WTSINFOEXW is { DWORD Level; WTSINFOEX_LEVEL Data; }. The union holds
            // LARGE_INTEGER fields, so it is 8-byte aligned and starts at offset 8.
            if (Marshal.ReadInt32(buffer) != 1) return null;
            var head = Marshal.PtrToStructure<Level1Head>(buffer + 8);
            int flags = head.SessionFlags;

            // Windows 7 / Server 2008 R2 report these two values swapped (documented defect).
            bool win7 = Environment.OSVersion.Version is { Major: 6, Minor: 1 };
            return flags switch
            {
                WTS_SESSIONSTATE_LOCK => !win7,
                WTS_SESSIONSTATE_UNLOCK => win7,
                _ => null,
            };
        }
        finally
        {
            WTSFreeMemory(buffer);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Level1Head
    {
        public uint SessionId;
        public int SessionState;   // WTS_CONNECTSTATE_CLASS
        public int SessionFlags;
    }

    public static int ActiveConsoleSessionId() => WTSGetActiveConsoleSessionId();
}
```

ここには間違えやすい点が 3 つあります。

- **オフセットは 4 ではなく 8 です。** `WTSINFOEXW` 内の共用体には `LARGE_INTEGER` メンバーが含まれているため、x86 と x64 のどちらでも 8 バイト境界に配置されます。`4 + 4 + 4` の位置で `SessionFlags` を読むと、でたらめな値が得られます。`WTSINFOEX_LEVEL1_W` の最初の 3 フィールドだけをマーシャリングすれば、不要な固定長の名前バッファーを宣言せずに済みます。
- **Windows 7 と Server 2008 R2 では値が入れ替わっています。** MS Learn の `WTSINFOEX_LEVEL1_W` のページには、これらのバージョンでは `LOCK` がロック解除を意味し、その逆も同様というコードの不具合が記載されています。もう Windows 7 向けに出荷していないかもしれませんが、Server 2008 R2 のマシンはまだ一部の環境に残っており、このチェックにコストはかかりません。
- **サービスは実際のセッション ID を渡します。** サービスから `WTS_CURRENT_SESSION` を指定するとセッション 0 を意味します。`SessionChangeDescription.SessionId` を渡すか、物理コンソールにいるユーザーについては `WTSGetActiveConsoleSessionId()` を渡してください。

`SessionFlags` は `WTS_SESSIONSTATE_UNKNOWN` (`0xFFFFFFFF`) になることもあります。たとえばユーザーのいないセッションの場合です。メソッドが `bool?` を返すのはそのためです。

## WM_WTSSESSION_CHANGE を自分でフックする

`SystemEvents` は便利ですが、追加のスレッドと隠れたウィンドウというコストがかかり、`Delegate.DynamicInvoke` を介してマーシャリングします。すでに自分でウィンドウを持っているなら、そのウィンドウを直接登録するほうが軽量で、`lParam` でセッション ID を受け取れるうえ、マネージドの列挙型には名前のない `WTS_SESSION_CREATE` (0xA) と `WTS_SESSION_TERMINATE` (0xB) も受け取れます。WPF では `HwndSource` をフックします。

```csharp
// .NET 10, C# 14, WPF
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

public partial class MainWindow : Window
{
    private const int WM_WTSSESSION_CHANGE = 0x02B1;
    private const int NOTIFY_FOR_THIS_SESSION = 0;
    private const int WTS_SESSION_LOCK = 0x7;
    private const int WTS_SESSION_UNLOCK = 0x8;

    [LibraryImport("wtsapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool WTSRegisterSessionNotification(nint hWnd, int dwFlags);

    [LibraryImport("wtsapi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool WTSUnRegisterSessionNotification(nint hWnd);

    private HwndSource? _source;

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        _source = (HwndSource)PresentationSource.FromVisual(this);
        _source.AddHook(WndProc);
        if (!WTSRegisterSessionNotification(_source.Handle, NOTIFY_FOR_THIS_SESSION))
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastPInvokeError());
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        if (_source is not null)
        {
            WTSUnRegisterSessionNotification(_source.Handle);
            _source.RemoveHook(WndProc);
        }
        base.OnClosed(e);
    }

    private nint WndProc(nint hwnd, int msg, nint wParam, nint lParam, ref bool handled)
    {
        if (msg == WM_WTSSESSION_CHANGE)
        {
            // lParam is the session id the change applies to.
            switch ((int)wParam)
            {
                case WTS_SESSION_LOCK: PauseSensitiveUi(); break;
                case WTS_SESSION_UNLOCK: ResumeSensitiveUi(); break;
            }
        }
        return 0;
    }

    private void PauseSensitiveUi() => Title = "Locked";
    private void ResumeSensitiveUi() => Title = "Unlocked";
}
```

WinForms では、同じことを `WndProc` のオーバーライドと、`OnHandleCreated` での登録、`OnHandleDestroyed` での登録解除で行います。コンストラクターと `Dispose` ではなくハンドルのイベントを使ってください。WinForms はフォームのハンドルを再作成することがあり (`ShowInTaskbar` や `RightToLeft` を変更すると起こります)、新しいハンドルは登録されていないからです。

```csharp
// .NET 10, C# 14, Windows Forms
using System.Runtime.InteropServices;

public partial class MainForm : Form
{
    private const int WM_WTSSESSION_CHANGE = 0x02B1;

    [LibraryImport("wtsapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool WTSRegisterSessionNotification(nint hWnd, int dwFlags);

    [LibraryImport("wtsapi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool WTSUnRegisterSessionNotification(nint hWnd);

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        WTSRegisterSessionNotification(Handle, 0 /* NOTIFY_FOR_THIS_SESSION */);
    }

    protected override void OnHandleDestroyed(EventArgs e)
    {
        WTSUnRegisterSessionNotification(Handle);
        base.OnHandleDestroyed(e);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_WTSSESSION_CHANGE)
        {
            var reason = (Microsoft.Win32.SessionSwitchReason)(int)m.WParam;
            Text = $"{reason} (session {(int)m.LParam})";
        }
        base.WndProc(ref m);
    }
}
```

Win32 のドキュメントでは、ウィンドウが破棄される前に、成功した登録 1 回につき 1 回の `WTSUnRegisterSessionNotification` が必要とされています。省略しても何もクラッシュしませんが、2 年後にサポートチケットとして表面化するたぐいのリークです。

## 本番環境で表面化する落とし穴

- **早期の自動起動では登録に失敗することがあります。** `WTSRegisterSessionNotification` は、Remote Desktop Services の準備が整う前に実行されると `RPC_S_INVALID_BINDING` で失敗することがあります。ドキュメントでは `Global\TermSrvReadyEvent` イベントを待つよう指示されています。`SystemEvents` は最初の `SessionSwitch` の購読時に 1 回だけ登録し、結果を確認しません。ログオン時に `Run` キーから起動されるアプリならほぼ問題ありませんが、起動処理のごく早い段階で開始されるものは、直接登録してリトライするか、単純にサービスにするべきです。
- **ロックが常に `SessionLock` になるとは限りません。** ユーザーの簡易切り替えでは、通常、離れる側のセッションに `ConsoleDisconnect` が発生し、既存のセッションへの RDP 再接続では `RemoteConnect` が発生します。本当に意味するところが "ユーザーがこのセッションを見ていない" であれば、切断の理由も処理し、`IsLocked()` で確認してください。
- **作業の保存にログオフイベントを使わないでください。** `SessionLogoff` がサービスに届く頃には、ユーザーのプロセスはシャットダウン中です。ログオフやシャットダウン時に状態を永続化する必要があるデスクトップアプリは、`SystemEvents.SessionEnding` (`WM_QUERYENDSESSION` から発生し、理論上はキャンセル可能) または `SessionEnded` (`WM_ENDSESSION` から発生) を処理し、素早く済ませるべきです。
- **ハンドラーを決してブロックしないでください。** これは `.NET System Events` スレッドにも、サービスのスレッドプールのコールバックにも当てはまります。チャネルに書き込んで戻るのが安全なデフォルトであり、[BackgroundService の比較記事](/ja/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/) でも、長時間実行される作業をホステッドサービスに渡す方法として推奨しています。
- **セッション 0 にはデスクトップがありません。** `SessionLogon` に反応して UI を表示するサービスは、どこにも表示されません。ユーザーのセッションでヘルパープロセスを起動する (`WTSQueryUserToken` と `CreateProcessAsUser`) か、ユーザーごとのトレイアプリで `SessionSwitch` を受け取り、名前付きパイプでサービスと通信させてください。

覚えておくべきルールを 1 つ挙げるなら、こうです。ユーザーのセッション内では `SystemEvents.SessionSwitch` (ウィンドウを持っているなら生のウィンドウメッセージ) を使い、ロック、ロック解除、接続のイベントは受け取れても自分自身のログオンは受け取れないと想定します。すべてのセッションを対象にするなら `OnSessionChange` を備えたサービスを使い、順序が重要なときは状態を問い合わせ直します。

## 参考資料

- MS Learn の [SystemEvents.SessionSwitch イベント](https://learn.microsoft.com/en-us/dotnet/api/microsoft.win32.systemevents.sessionswitch)
- [ServiceBase.OnSessionChange](https://learn.microsoft.com/en-us/dotnet/api/system.serviceprocess.servicebase.onsessionchange) と [CanHandleSessionChangeEvent](https://learn.microsoft.com/en-us/dotnet/api/system.serviceprocess.servicebase.canhandlesessionchangeevent)
- [WTSRegisterSessionNotification](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsregistersessionnotification) と [WM_WTSSESSION_CHANGE](https://learn.microsoft.com/en-us/windows/win32/termserv/wm-wtssession-change)
- [WTSINFOEX_LEVEL1_W](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w) (Windows 7 のフラグの不具合を含む)
- [SystemEvents.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Win32.SystemEvents/src/Microsoft/Win32/SystemEvents.cs) と、メッセージループのスレッドを無条件に作成するようにした [dotnet/runtime PR #53467](https://github.com/dotnet/runtime/pull/53467)
- dotnet/runtime の [ServiceBase.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/System.ServiceProcess.ServiceController/src/System/ServiceProcess/ServiceBase.cs) と [WindowsServiceLifetime.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Hosting.WindowsServices/src/WindowsServiceLifetime.cs)
