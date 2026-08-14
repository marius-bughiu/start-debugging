---
title: "Fix: mprotect failed: 13 (Permission denied) in a Flutter iOS debug build"
description: "iOS blocks the Dart VM from flipping memory pages to executable, so JIT dies at startup. Upgrade to Flutter 3.35.0 or later for iOS 26, 3.32.0 for iOS 18.4. There is no entitlement that fixes it."
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "ios"
  - "xcode"
---

Upgrade Flutter. This crash is iOS refusing to let the Dart VM turn a writable memory page into an executable one, which is exactly what JIT needs and exactly what debug mode runs on. Flutter 3.35.0 (Dart 3.9.0, 14 August 2025) is the first stable release that survives it on physical iOS 26 devices; Flutter 3.32.0 (Dart 3.8.0) was the first that survived it on iOS 18.4. There is no entitlement, no Info.plist key, and no build flag you can add to an older SDK to make this go away. If you are already on 3.35.0 or later and still crashing, your Xcode scheme is missing its LLDB Init File, which is the second half of the fix.

## The crash, in full

The app dies during `Dart_Initialize`, before a single widget is built:

```
../../../flutter/third_party/dart/runtime/vm/virtual_memory_posix.cc: 428: error: mprotect failed: 13 (Permission denied)
version=3.7.0 (stable) (Wed Feb 5 04:53:58 2025 -0800) on "ios_arm64"
pid=726, thread=259, isolate_group=vm-isolate(0x11ea52800), isolate=vm-isolate(0x11ebe5800)
os=ios, arch=arm64, comp=no, sim=no
  pc 0x0000000110302e84 fp 0x000000016eee4f50 Dart_DumpNativeStackTrace+0x18
  pc 0x000000010feb1428 fp 0x000000016eee4f70 dart::Assert::Fail(char const*, ...) const+0x30
  pc 0x000000010ffac33c fp 0x000000016eee5420 dart::Code::FinalizeCode(...)+0x82c
  pc 0x0000000110039cb0 fp 0x000000016eee5a30 dart::StubCode::Init()+0x320
  pc 0x000000010fefc4f4 fp 0x000000016eee64e0 dart::Dart::DartInit(Dart_InitializeParams const*)+0x2b18
  pc 0x00000001102e9754 fp 0x000000016eee6960 Dart_Initialize+0x60
  pc 0x000000010fe71e24 fp 0x000000016eee6f30 flutter::DartVM::Create(...)+0x1d64
=== Crash occurred when compiling unknown function in unoptimized JIT mode in unknown pass
```

Three details identify it beyond doubt. The frame is `dart::StubCode::Init()`, which runs before your code exists, so nothing in your Dart is responsible. The `13` is `EACCES` from POSIX `mprotect`. And the final line names JIT mode explicitly.

## Why does iOS refuse the mprotect call?

Debug builds of Flutter run the Dart VM in JIT mode. That is not an implementation detail you can opt out of: hot reload works by compiling new Dart into machine code inside the running process, which means the VM writes bytes into a page and then executes them.

Apple's W^X policy says a page can be writable or executable, never both at once. The classic way around that is to allocate a page RW, write the compiled code, then call `mprotect(PROT_READ | PROT_EXEC)` to flip it. The Dart VM did exactly that, in `VirtualMemory::Protect` at `runtime/vm/virtual_memory_posix.cc`.

Starting with the iOS 18.4 betas and tightened again in iOS 26, the kernel stopped allowing that transition for third party apps, even with the `get-task-allow` entitlement that a development build carries. `mprotect` returns `EACCES`, the VM's `ASSERT` fires, and the process aborts. This is the whole of [flutter/flutter#163984](https://github.com/flutter/flutter/issues/163984), a P1 that ran from February to July 2025 and drew 61 comments.

Two consequences worth internalising before you start changing things:

**Release and profile builds are unaffected.** They are AOT compiled. The machine code is already in the app binary, mapped executable by the loader, and the VM never asks for a protection change. If your CI is green and your TestFlight build runs, that is expected and it is not evidence that your setup is fine.

**The simulator is unaffected.** It runs on the macOS kernel, which does not enforce the restriction. A team where one developer tests on a simulator and another on a device will see this split cleanly down the middle, which is what makes the first hour of debugging so confusing.

## Which Flutter version do I actually need?

The fix arrived in two pieces, in two different stable releases. I verified the commit ancestry with the GitHub compare API against the Dart SDK release tags rather than trusting the issue thread.

| Target | First stable that works | Dart | Released |
| --- | --- | --- | --- |
| iOS 18.4 physical device | Flutter 3.32.0 | 3.8.0 | 2025-05-20 |
| iOS 26 physical device | Flutter 3.35.0 | 3.9.0 | 2025-08-14 |
| iOS 26, tool drives LLDB itself | Flutter 3.38.0 | 3.10.0 | 2025-11-12 |

The first piece is the `NOTIFY_DEBUGGER_ABOUT_RX_PAGES` hook in the VM, added in Dart commit `939699a9` on 28 February 2025. It is an ancestor of the `3.8.0` tag, so anything from Flutter 3.32.0 onward has it.

The second piece is dual mapping of code pages, three commits in June 2025 (`d194fcec`, `dc0567c0`, `c111f693`). Those are ancestors of `3.9.0` but not of `3.8.1`, which is why 3.32.x crashes on iOS 26 while 3.35.0 does not. Instead of flipping one mapping's protection, the VM now maps the same physical memory twice: an RW view the compiler writes through, and a separate RX view the CPU executes from. No `mprotect` call, nothing for the kernel to refuse.

So the practical instruction is one line:

```bash
# Latest stable at time of writing is 3.47.0 (Dart 3.13.0, 2026-08-12)
flutter upgrade
flutter clean
```

The `flutter clean` is not superstition. The Flutter tool writes generated LLDB files into `ios/Flutter/ephemeral/`, and stale copies from a previous SDK caused misfires that were reported repeatedly on the issue while the fix was being rolled out.

## I am on Flutter 3.35 or later and it still crashes

Then the VM is fine and the debugger side is not. Dual mapping is necessary but not sufficient: the RX mapping only becomes valid when the debugger touches the pages, so LLDB has to be part of the launch. Flutter wires that up through the Xcode scheme, and if the scheme is missing the setting you get the same `mprotect` crash back.

The tool tries to migrate the scheme for you on every debug or profile build. When it cannot, it prints this:

```
Running Flutter in debug mode on new iOS versions requires a LLDB Init File,
but the Runner scheme does not have it set. To ensure debug mode works, please
complete the following:
  * Open Xcode > Product > Scheme > Edit Scheme and for the Run and Test actions,
    set LLDB Init File to:

  $(SRCROOT)/Flutter/ephemeral/flutter_lldbinit
```

Do exactly that, and note that it wants both the Run action and the Test action. The migration checks each independently and will complain about whichever one is missing. If you already have your own LLDB Init File, Flutter will not overwrite it; instead it tells you to chain to its file from yours:

```
command source /path/to/ios/Flutter/ephemeral/flutter_lldbinit
```

For an add-to-app project the path is different, because the Flutter module is built as a Swift package and the generated files land in the package output. Set the scheme's LLDB Init File to `$(FLUTTER_SWIFT_PACKAGE_OUTPUT)/Scripts/flutter_lldbinit`, or source it relative to your own file:

```
command source --relative-to-command-file "../my_flutter_app/build/ios/SwiftPackages/Scripts/flutter_lldbinit"
```

Add-to-app hosts get a warning rather than an error here, because the tool cannot know which of your schemes is the one you launch from. It scans every `.xcscheme` in the project for the string `customLLDBInitFile` and only warns if none of them has it. A project with five schemes where the wrong one is configured will pass that check and still crash.

## How does JIT work at all now, if mprotect is blocked?

Worth understanding, because it explains the constraint in the next section.

The generated `ios/Flutter/ephemeral/flutter_lldb_helper.py` sets a breakpoint on a symbol the VM exports purely as a signal to the debugger, then writes into the pages from the debugger side, which is allowed to modify a debugged process's executable memory:

```python
# Generated by Flutter 3.44.2 into ios/Flutter/ephemeral/flutter_lldb_helper.py
import lldb

def handle_new_rx_page(frame: lldb.SBFrame, bp_loc, extra_args, intern_dict):
    """Intercept NOTIFY_DEBUGGER_ABOUT_RX_PAGES and touch the pages."""
    base = frame.register["x0"].GetValueAsAddress()
    page_len = frame.register["x1"].GetValueAsUnsigned()

    data = bytearray(page_len)
    data[0:8] = b'IHELPED!'

    error = lldb.SBError()
    frame.GetThread().GetProcess().WriteMemory(base, data, error)
    if not error.Success():
        print(f'Failed to write into {base}[+{page_len}]', error)
        return

def __lldb_init_module(debugger: lldb.SBDebugger, _):
    target = debugger.GetDummyTarget()
    bp = target.BreakpointCreateByRegex("^NOTIFY_DEBUGGER_ABOUT_RX_PAGES$")
    bp.SetScriptCallbackFunction('{}.handle_new_rx_page'.format(__name__))
    bp.SetAutoContinue(True)
    print("-- LLDB integration loaded --")
```

The `IHELPED!` marker is a diagnostic: `NOTIFY_DEBUGGER_ABOUT_RX_PAGES` reads the first eight bytes back and can therefore tell the difference between "the debugger handled this" and "no breakpoint was ever set", which is the difference between a working setup and the crash at the top of this article.

If you see `-- LLDB integration loaded --` in the Xcode console, the init file is wired up correctly.

## What changed in Flutter 3.38 and later?

From Flutter 3.38.0 the tool stopped delegating to Xcode for physical devices and drives `devicectl` and `lldb` itself (PRs [#173417](https://github.com/flutter/flutter/pull/173417), [#173443](https://github.com/flutter/flutter/pull/173443) and [#173724](https://github.com/flutter/flutter/pull/173724)). `flutter run` launches the app stopped, then feeds LLDB this sequence:

```
device select <device-id>
breakpoint set --func-regex '^NOTIFY_DEBUGGER_ABOUT_RX_PAGES$'
breakpoint command add --script-type python <breakpoint-id>
device process attach --pid <app-pid>
process continue
```

It is gated behind a feature flag that is on by default on every channel. Confirmed against a local Flutter 3.44.2 install, `packages/flutter_tools/lib/src/features.dart` declares:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/features.dart
const lldbDebugging = Feature(
  name: 'support for debugging with LLDB for physical iOS devices',
  configSetting: 'enable-lldb-debugging',
  environmentOverride: 'FLUTTER_LLDB_DEBUGGING',
  master: FeatureChannelSetting(available: true, enabledByDefault: true),
  beta: FeatureChannelSetting(available: true, enabledByDefault: true),
  stable: FeatureChannelSetting(available: true, enabledByDefault: true),
);
```

It requires iOS 17 or newer and Xcode 26 or newer. Below either threshold the tool silently falls back to launching through Xcode, which is why a machine still on Xcode 16 can show completely different symptoms from a colleague's on the same Flutter version. Check `xcodebuild -version` before you compare notes.

You can turn it off globally or per project if it misbehaves:

```bash
flutter config --no-enable-lldb-debugging
```

```yaml
# pubspec.yaml, disables LLDB debugging for this project only
flutter:
  config:
    enable-lldb-debugging: false
```

## What if I cannot upgrade Flutter?

If you are pinned to an old SDK, and 3.7.x pins were common in the issue thread, there is no backport and there is no workaround inside the app. Your options are to test on the simulator, to test on a device still running iOS 18.3 or earlier, or to run `flutter run --profile`, which is AOT compiled and therefore immune. Profile mode costs you hot reload but keeps DevTools, the timeline, and the widget inspector, so it is a usable stopgap for UI work that is not iteration-heavy.

Upgrading a long-pinned SDK across four stable releases is its own project. If you are managing several apps on different pins, [targeting multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) is the cheaper way to stage it than upgrading everything at once.

## Gotchas that look like this bug but are not

**A debug build now needs the debugger to stay attached.** Starting a debugserver on the device is what makes JIT legal, so a debug build launched from the home screen with no debugger attached will crash the same way. This is not a regression to report; it is the mechanism. Use a profile or release build for anything you hand to a tester.

**Wireless debugging on iOS 26 is slow, not broken.** Flutter 3.44 prints "Wireless debugging on iOS 26 may be slower than expected. For better performance, consider using a wired (USB) connection." Each RX page handoff is a round trip to the debugger, and over Wi-Fi that adds up. Several reports of ten second stalls on the original issue turned out to be this. Plug in the cable before you file a bug.

**Release builds on CI complaining about `customLLDBInitFile`.** The scheme migration only runs for debug and profile builds, but a misconfigured scheme can still surface in release pipelines. If your CI is failing on the init file for a release build, the problem is the scheme, not this crash: a release build has no JIT and needs no LLDB.

**Flavors get their own schemes.** Flutter migrates the scheme that resolves for the flavor being built. If you have `dev`, `staging`, and `prod` schemes and only ever run `dev` locally, the other two are unmigrated until someone builds them, and they will each fail once.

**Anything mentioning `mprotect` on Android is a different problem.** Android build failures around memory pages are almost always the 16 KB page size requirement, which is a packaging and alignment issue, not a JIT one. That has [its own fix involving NDK r28 and zipalign](/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).

## Related

If the app never gets as far as launching, the failure is upstream of the VM: [Failed to build iOS app with Xcode 16 and Flutter 3.x](/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/) and [CocoaPods could not find compatible versions for pod](/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/) cover the two failures that account for most of the rest. Because this crash only reproduces on hardware, it is also worth having a [real device workflow for debugging Flutter iOS from Windows](/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) so a Mac is not a prerequisite for reproducing it. And if the upgrade to 3.35 or later drags a lot of other breakage in with it, the [Flutter 3.x null safety checklist](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) is the ordering I use for old codebases.

## Sources

- [Debug mode and hot reload fail on iOS 26 due to JIT restriction `error: mprotect failed: 13 (Permission denied)`](https://github.com/flutter/flutter/issues/163984), the P1 tracking issue, for the original crash dump and the fix timeline.
- [Add lldb init file](https://github.com/flutter/flutter/pull/164344) (flutter/flutter#164344, merged 6 March 2025), shipped in the [Flutter 3.32.0 release notes](https://docs.flutter.dev/release/release-notes/release-notes-3.32.0).
- [Flutter 3.38.0 release notes](https://docs.flutter.dev/release/release-notes/release-notes-3.38.0), for LLDB and `devicectl` becoming the default launch path on iOS 17+ with Xcode 26+.
- [Integrate a Flutter app into your iOS project](https://docs.flutter.dev/add-to-app/ios/project-setup), for the add-to-app LLDB Init File paths.
- Dart SDK commits `939699a9` (`[vm] Add NOTIFY_DEBUGGER_ABOUT_RX_PAGES hook`), `d194fcec` (`[vm] Use dual mapping of code pages on certain OS versions`), `dc0567c0` and `c111f693`, with tag ancestry checked against the `3.8.1` and `3.9.0` release tags.
- Source quoted from a local Flutter 3.44.2 stable install: `packages/flutter_tools/lib/src/features.dart`, `lib/src/ios/lldb.dart`, `lib/src/xcode_project.dart`, `lib/src/migrations/lldb_init_migration.dart`, and `lib/src/build_system/targets/ios.dart`.
