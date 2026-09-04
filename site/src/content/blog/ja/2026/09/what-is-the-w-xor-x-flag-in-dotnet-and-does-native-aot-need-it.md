---
title: ".NET の W^X フラグとは何か、Native AOT はそれを必要とするのか?"
description: "W^X (write xor execute) は、いかなるメモリページも書き込み可能と実行可能を同時に満たさないという規則です。.NET では DOTNET_EnableWriteXorExecute というノブとして公開され、.NET 7 以降は既定で有効で、その存在理由はもっぱら JIT にあります。Native AOT はこのノブを一度も読みません。ランタイムがどう実装しているか、何を犠牲にするか、そして無効化が正当な対処になるのはどんなときかを解説します。"
pubDate: 2026-09-04
tags:
  - "dotnet"
  - "native-aot"
  - "jit"
  - "performance"
  - "security"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/09/what-is-the-w-xor-x-flag-in-dotnet-and-does-native-aot-need-it"
translatedBy: "claude"
translationDate: 2026-09-04
---

W^X ("write xor execute") はメモリ保護のポリシーです。任意のメモリページは書き込み可能か実行可能のどちらかであってよく、同時に両方であってはなりません。.NET では `DOTNET_EnableWriteXorExecute` というノブとして公開されており、その既定値は .NET 7 以降 `1` です。この質問の一般的な言い回しに埋め込まれた前提は逆向きなので、最初に正しておきます。Native AOT は W^X フラグを必要としませんし、読みもしません。このフラグが設定するのは CoreCLR の実行可能メモリアロケーターであり、それは JIT のために存在します。Native AOT には JIT も実行可能メモリアロケーターもありません。実際の関係は逆方向です。W^X を例外なく強制するプラットフォーム (iOS、tvOS) では JIT コンパイルが不可能になり、Native AOT はその制約に対する答えであって、このフラグの利用者ではありません。

以下の内容はすべて .NET 11 SDK での `<TargetFramework>net11.0</TargetFramework>` を対象としていますが、仕組み自体は .NET 7 以降安定しています。特定のバージョンに依存する挙動については、その都度明記します。

## ページが書き込み可能かつ実行可能であることがなぜ問題なのか

古典的なメモリ破壊エクスプロイトは 2 つの半分から成ります。攻撃者が制御するバイト列をプロセス内に送り込むことと、CPU にそこへジャンプさせることです。プロセス内のすべてのページが書き込み可能か実行可能のどちらかであれば、後半が機能しなくなります。書き込んだバイト列は CPU が実行を拒否するページ上にあり、CPU が実行してくれるページには書き込めません。このポリシーは 2003 年に OpenBSD から生まれ、今では当然の前提です。Windows は自身の実装を DEP と呼び、Linux は NX ビットとローダーのページ権限に依拠し、Apple silicon はすべてのプロセスに対してカーネルレベルで強制します。

通常のコンパイル済みコードにとって、これは無料です。ローダーは `.text` セクションを読み取り実行、`.data` セクションを読み取り書き込みでマップし、その後は何も変更する必要がありません。厄介なのは、プログラムの実行中に機械語を生成するランタイムです。

## なぜ JIT が厄介なケースなのか

JIT コンパイラーは機械語のバイト列をメモリに書き込み、それを呼び出します。素朴な実装は RWX のページを確保し、書き込み、そこへジャンプします。これはまさに W^X が禁じようとしている形であり、攻撃者に対して、ほぼ安定したアドレスで書き込み可能かつ実行可能であることが保証されたページを差し出すことになります。

素直な対処は、ページを読み取り書き込みで確保し、コードを出力してから `mprotect` で読み取り実行に切り替えることです。CoreCLR にとってはこれでは不十分で、理由は 2 つあります。第一に、ページが書き込み可能でありながらアドレスがすでに判明している時間帯が生じます。第二に、そしてより重要なことに、ランタイムはコードを一度書いて終わりにしません。継続的にパッチを当てます。メソッドが階層のしきい値を超えると呼び出しカウント用のスタブが書き換えられ、[階層型コンパイル](/ja/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/)は階層 0 のコードを階層 1 のコードに差し替え、単相な呼び出し箇所が解決されるにつれて仮想スタブディスパッチのセルが再パッチされます。パッチのたびにページを RW と RX の間で切り替えるのは遅く、しかもスレッド間で競合状態を招きます。

## CoreCLR の実際の実装: ダブルマッピング

CoreCLR の答えは、同じ物理メモリに対して 2 つの仮想マッピングを作ることです。一方のマッピングは読み取り実行で、CPU が実行するのはこちらです。もう一方は読み取り書き込みで、ランタイムが書き込むのはこちらを通してです。単一の仮想アドレスが両方の性質を持つことは決してないためポリシーは保たれますが、それでいてランタイムはページ権限を一切変更せずにコードへパッチを当て続けられます。

その配管が `src/coreclr/inc/executableallocator.h` にある `ExecutableAllocator` と RAII ヘルパーの `ExecutableWriterHolder` です。コードを変更したい VM 内のあらゆる箇所は writer holder を取得し、`holder.GetRW()` を通して書き込み、デストラクターに書き込み可能ビューを破棄させます。バッキングストアは `src/coreclr/minipal/Unix/doublemapping.cpp` で作られ、Linux では次のようになります。

```c
// dotnet/runtime, src/coreclr/minipal/Unix/doublemapping.cpp
int fd = memfd_create("doublemapper", MFD_CLOEXEC);
```

FreeBSD では `shm_open(SHM_ANON, ...)` を使い、それ以外の Unix システムでは `/shm-dotnet-<pid>` という名前の POSIX 共有メモリオブジェクトにフォールバックし、直後に `shm_unlink` します。この memfd こそ、プロセスの外から実際に観測できる部分です。

```bash
# Linux, .NET 11. Count the double mappings in a running .NET process.
grep -c doublemapper /proc/$(pgrep -n MyApp)/maps
```

Apple のプラットフォームは別の経路をとります。`CreateDoubleMemoryMapper` は Apple 上ではファイルディスクリプターを一切作らずに早期リターンします。arm64 の macOS は代わりにスレッド単位の仕組みを提供しているからです。`MAP_JIT` で確保したページは、`pthread_jit_write_protect_np` を通じて呼び出し元スレッドに限って書き込み可能と実行可能を切り替えられます。ランタイムはこれを `PAL_JitWriteProtect` としてラップしており、`HOST_APPLE && HOST_ARM64` では writer holder は 2 つ目のマッピングではなく同じアドレスをそのまま返します。

```cpp
// dotnet/runtime, executableallocator.h, Apple arm64 path
m_addressRW = addressRX;
PAL_JitWriteProtect(true);
```

このスレッド単位というスコープが見落とされがちな点です。Apple silicon では書き込み権限はページではなくスレッドに属します。だからこそ、あるスレッドが領域に書き込んでいる最中に別のスレッドがそれを実行するようなことは決してさせてはいけません。

## フラグ本体と設定方法

このノブは `src/coreclr/inc/clrconfigvalues.h` でただ一度だけ宣言されています。

```cpp
// dotnet/runtime, src/coreclr/inc/clrconfigvalues.h
RETAIL_CONFIG_DWORD_INFO(EXTERNAL_EnableWriteXorExecute, W("EnableWriteXorExecute"), 1,
                         "Enable W^X for executable memory.");
```

`TARGET_RISCV64` を除くすべてのアーキテクチャで既定値は `1` で、RISC-V64 では同じ宣言が既定値 `0` を出荷します。既定になったのは [PR #69672](https://github.com/dotnet/runtime/pull/69672) で、.NET 7 向けに 2022 年 5 月にマージされました。それ以前の .NET 6 では、macOS arm64 (OS が選択の余地を与えないプラットフォーム) でのみ既定で有効、それ以外ではオプトインという形で出荷されており、これは [.NET 6 の発表](https://devblogs.microsoft.com/dotnet/announcing-net-6/)が約束したとおりです。

設定方法は 2 つあります。環境変数はどこでも機能します。

```bash
# Disables W^X for this process only. .NET 7 and later.
DOTNET_EnableWriteXorExecute=0 ./MyApp
```

.NET 9 以降では、[PR #101490](https://github.com/dotnet/runtime/pull/101490) のおかげで `runtimeconfig.json` に置くこともできます。

```json
{
  "configProperties": {
    "System.Runtime.EnableWriteXorExecute": 0
  }
}
```

SDK スタイルのプロジェクトでは、リビルドを跨いで残るように MSBuild の項目として表現します。

```xml
<!-- .NET 9 and later. Ignored by .NET 8 and earlier, which need the env var. -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="System.Runtime.EnableWriteXorExecute" Value="0" />
</ItemGroup>
```

runtimeconfig 経由の経路は .NET 8 にバックポートされませんでした。[issue #103340](https://github.com/dotnet/runtime/issues/103340) の要望は not planned として閉じられています。.NET 8 では環境変数が唯一の手段です。また .NET 9 の優先順位変更にも注意してください。今では環境変数が `runtimeconfig.json` に優先するため、コンテナーイメージに紛れ込んだ `DOTNET_EnableWriteXorExecute` がプロジェクトの設定を黙って上書きします。

## 何を犠牲にするのか

この緩和策は無料ではなく、ランタイムチームは既定で有効にする前に計測しています。[PR #69672](https://github.com/dotnet/runtime/pull/69672) にある数値では、x64 Windows、x64 Linux、arm64 Linux 上の ASP.NET plaintext、json、fortunes、orchard の各ベンチマークで起動時間が 5 から 10 パーセント悪化し、その後の分析では最初のリクエストまでの時間がおよそ 10 パーセント悪化すると見積もられました。定常状態では計測可能な差はありませんでした。これは理にかなっています。ホットなメソッドが JIT され、パッチが当たってしまえば、実行可能メモリアロケーターは意味のあるパス上から消えるからです。

最初に出荷されたバージョンは、JIT を大量に走らせるワークロードではそれより悪いものでした。[PR #74526](https://github.com/dotnet/runtime/pull/74526) は正規表現テストの性能低下を追跡し、原因が約 50,000 個のメソッドを JIT すること、そのたびに新しい書き込み可能マッピングを確保して解放することにあると突き止めました。直近に使った書き込み可能マッピングを即座にアンマップせずキャッシュすることで完全に解消し、既定値の切り替えと同時に .NET 7 で出荷されました。.NET 7 以降で起動時間を計測しているなら、この修正はすでに入っています。

実務的な読み方はこうです。W^X が犠牲にするのは起動時間であって、スループットではありません。これは短命なプロセスやコールドスタートでは効いてきますが、長時間動き続けるサーバーではほとんど問題になりません。これは [Native AOT と ReadyToRun と素の JIT](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) が天秤にかけているのと同じ軸です。

## Native AOT が実際に立っている位置

さて、質問が逆にしている部分です。Native AOT が発行するバイナリは、コードがビルド時に完全にコンパイルされ、C のプログラムとまったく同じように OS のローダーによって読み取り実行でマップされます。JIT も階層化もスタブの再パッチも存在せず、したがって `ExecutableAllocator` も存在しません。`src/coreclr/nativeaot/Runtime` 以下の Native AOT ランタイムを grep しても、`EnableWriteXorExecute` はどこにも見つかりません。Native AOT のバイナリに対してこのフラグを設定しても、何一つ起こりません。このノブは CoreCLR VM の構成値であり、Native AOT ランタイムは CLR の構成を一度も読まない、別物のはるかに小さなランタイムだからです。

実行時のコード生成が存在しないことは、マネージドコードから確認できます。

```csharp
// .NET 11, C# 14. Prints False under Native AOT, True under CoreCLR.
using System.Runtime.CompilerServices;

Console.WriteLine(RuntimeFeature.IsDynamicCodeCompiled);
```

とはいえ、これは Native AOT が実行時に実行可能メモリをまったく確保しないという意味ではありません。ある特定の理由のために、少しだけ確保します。マーシャリングされるデリゲートです。マネージドなインスタンスデリゲートを関数ポインターとしてネイティブコードに渡すとき、遷移先のアドレスはどのデリゲートインスタンスを呼び出すかを符号化していなければなりません。そしてそれはビルド時にはインスタンスが存在しないためイメージに焼き込めません。ランタイムはデリゲートごとに小さな thunk を実体化します。

```csharp
// .NET 11, C# 14. This is the call that forces a runtime-allocated thunk.
using System.Runtime.InteropServices;

Action<int> callback = Console.WriteLine;
nint fnPtr = Marshal.GetFunctionPointerForDelegate(callback);
// fnPtr points at a thunk allocated from a thunk pool, not at compiled image code.
GC.KeepAlive(callback);
```

これらの thunk は `PalAllocateThunksFromTemplate` から来ます。`src/coreclr/nativeaot/Runtime/unix/PalUnix.cpp` におけるそのシグネチャは次のとおりです。

```cpp
UInt32_BOOL PalAllocateThunksFromTemplate(HANDLE hTemplateModule, uint32_t templateRva,
                                          size_t templateSize, void** newThunksOut);
```

iOS 系プラットフォーム向けに [PR #82317](https://github.com/dotnet/runtime/pull/82317) で追加されたこの設計は、RWX のページを決して生み出しません。Apple のターゲットでは `vm_allocate` で隣接する 2 つの範囲を確保し、次に `vm_remap` を `VM_FLAGS_FIXED | VM_FLAGS_OVERWRITE` 付きで使って、ロード済みイメージからコンパイル済みのテンプレートコードページを実行可能側の半分にマップします。書き込み可能側の半分が保持するのは thunk ごとの*データ* (遷移先アドレスとデリゲートのハンドル) だけです。コードは実行時に書き込まれることはなく、指し示されるだけです。これはポリシーではなく構造による W^X 準拠であり、逃げ道を一切用意していないプラットフォームで機能する理由がまさにこれです。

同じファイルの `PalVirtualAlloc` は、macOS arm64 で実行可能メモリを確保する際には `MAP_JIT` を渡します。そこではカーネルがそれを要求するからです。

## 因果関係が実際に向かっている方向

Apple は、サードパーティの App Store アプリが RWX メモリをマップすることも、書き込んだ後のページを実行可能に切り替えることも許しません。出荷されるアプリについて、これを変える entitlement は存在しません。このたった 1 つの制約が JIT コンパイルを排除し、それとともに Mono の JIT モード、CoreCLR の階層化、コンパイル済みコードのホットリロードも排除します。Flutter がぶつかるのも同じ壁で、だからこそ最近の iOS バージョンでは[Flutter の iOS デバッグビルドが mprotect permission denied で失敗する](/ja/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/)一方で、完全に AOT コンパイルされたリリースビルドは影響を受けません。

したがって正確な捉え方はこうです。iOS が W^X を強制し、W^X が JIT を禁じ、Native AOT は JIT を禁じるプラットフォームに .NET がコードを届けるための手段である。Native AOT は .NET 9 以降 iOS 系プラットフォームをサポートしており、iOS と Mac Catalyst 上の .NET MAUI リリースビルドでは既定のコンパイルモードです。この連鎖のどこにも `EnableWriteXorExecute` フラグは関与しません。このフラグが支配してきたのは、放っておけば雑にやれてしまうプラットフォーム上で CoreCLR の JIT がどうやってバイト列をメモリに載せるか、その一点だけです。

## 無効化が正当な対処になるとき

W^X は多層防御のための緩和策です。無効化はプロセスのセキュリティ姿勢を実際に下げる行為なので、`DOTNET_EnableWriteXorExecute=0` はまず診断ツールとして扱い、恒久設定にするのは理由があるときだけにしてください。理由として通用するのは次のものです。

**Linux の `perf` で JIT コンパイルされたフレームをプロファイリングする。** ランタイムは perf マップを書くとき、CPU が実際に実行する RX マッピングではなく RW マッピングのアドレスを使うため、JIT フレームは誤ったシンボルに解決されるか、何にも解決されません。これは 2022 年 7 月から [issue #71786](https://github.com/dotnet/runtime/issues/71786) として開いたままで、いまだに Future マイルストーンに置かれています。JIT コンパイル済みコードについて使える `perf` プロファイルが必要なら、その実行に限って W^X を無効化してください。日常のプロファイリングには、[独自の rundown イベントを読む dotnet-trace](/ja/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) のほうが適しており、こちらは影響を受けません。

**`/memfd:doublemapper (deleted)` のエントリが増え続ける。** [issue #89776](https://github.com/dotnet/runtime/issues/89776) は、これらのマッピングが Linux で蓄積していく (macOS では解放されるが Linux では解放されない) ことを報告しており、長時間動作するサービスではマッピング数と仮想メモリの増加として現れます。ARM32 では同じ仕組みが完全なメモリリークとして報告され、OOM による強制終了を引き起こしています ([issue #121455](https://github.com/dotnet/runtime/issues/121455))。`/proc/<pid>/maps` が `doublemapper` で埋まっているなら、見ているのはこれです。

**ファイルサイズの rlimit 下での `SIGXFSZ`。** カーネルから見れば memfd はファイルなので、マッパーが要求するサイズを下回る `ulimit -f` はプロセスを `SIGXFSZ` で終了させます。これが [issue #117819](https://github.com/dotnet/runtime/issues/117819) でした。

**ネイティブデバッガーによるブレークポイントの設定。** `int3` を RW ではなく RX マッピング経由で書き込むとアクセス違反が発生していました。[issue #107444](https://github.com/dotnet/runtime/issues/107444) で追跡されています。`lldb` や `gdb` を .NET プロセスにアタッチしてブレークポイント挿入時に失敗するなら、そのデバッグセッションの間だけ W^X を無効化してください。

**Rosetta。** ここでは何もする必要がありません。ダブルマッピングは Rosetta エミュレーション下で正しく動作したためしがなく ([issue #70910](https://github.com/dotnet/runtime/issues/70910))、ランタイムが Rosetta を検出して W^X を自動的に無効化します。

このリストに載っていないのが「アプリの起動が遅い」です。コールドスタートが問題なら、このフラグが買えるのは 5 から 10 パーセントですが、まっとうな対処である ReadyToRun や [自前のコスト勘定を持つ Native AOT](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/) ならはるかに大きく、しかもプロセスを弱めません。上に挙げた具体的な症状のいずれかが出ているときにフラグへ手を伸ばし、どれが理由なのかをコメントとして隣に書き残してください。

## 関連記事

- [Native AOT とは何か、そして何を犠牲にするのか?](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [.NET 11 における Native AOT vs ReadyToRun vs JIT: どれを出荷すべきか](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [階層型コンパイルとは何か、どう捉えればよいのか？](/ja/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/)
- [dotnet-trace で .NET アプリをプロファイリングし、出力を読む方法](/ja/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)
- [解決: Flutter の iOS デバッグビルドで発生する mprotect failed: 13 (Permission denied)](/ja/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/)

## 出典

- [W^X support, dotnet/runtime PR #54954](https://github.com/dotnet/runtime/pull/54954)
- [Enable W^X by default, dotnet/runtime PR #69672](https://github.com/dotnet/runtime/pull/69672)
- [Enable caching of writeable W^X mappings, dotnet/runtime PR #74526](https://github.com/dotnet/runtime/pull/74526)
- [Read EnableWriteXorExecute from runtimeConfig, dotnet/runtime PR #101490](https://github.com/dotnet/runtime/pull/101490)
- [NativeAOT thunk page generation and mapping for iOS-like platforms, PR #82317](https://github.com/dotnet/runtime/pull/82317)
- [clrconfigvalues.h, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/coreclr/inc/clrconfigvalues.h)
- [doublemapping.cpp, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/coreclr/minipal/Unix/doublemapping.cpp)
- [Announcing .NET 6, .NET Blog](https://devblogs.microsoft.com/dotnet/announcing-net-6/)
- [.NET Runtime config options, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/)
- [Native AOT support for iOS-like platforms, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/ios-like-platforms/)
- [pthread_jit_write_protect_np(3), Apple](https://keith.github.io/xcode-man-pages/pthread_jit_write_protect_np.3.html)
