# Verification record — November 2, 2026

Executed locally on macOS arm64. These checks establish the listed behavior, not universal performance or platform coverage.

| Project | Actual checks | Result |
| --- | --- | --- |
| UnsafeAccessor | SDK 8.0.427 / runtime 8.0.33; expected constructor/member/field results | Passed |
| UnsafeAccessor Native AOT | Publish and execute `osx-arm64` with the .NET 8 toolchain | Passed |
| Access benchmarks | Functional equality of five call paths; all five BenchmarkDotNet Dry jobs on .NET 8.0.33 | Passed |
| Generic type benchmark | Functional result; both Dry jobs on actual runtimes 7.0.20 and 8.0.33 | Passed |
| Windows screenshot | Cross-build with Windows targeting packs | Passed; Windows execution and real desktop capture were not performed locally |
| React Native | Expo 58.0.22 web export; browser layout at 1280px and 390px | Seven cards, two columns, final partial row, no horizontal page overflow |

The access benchmark pins BenchmarkDotNet 0.15.8; the historical .NET 7/.NET 8 comparison pins BenchmarkDotNet 0.13.12, whose dependency targets fit that comparison. Dry jobs are execution smoke checks: their one-iteration timings are not published as speedup evidence. The historical comparison project targets both `net7.0` and `net8.0`; a project targeting only .NET 8 cannot supply BenchmarkDotNet's .NET 7 project reference.

The Windows self-test uses a synthetic bitmap and is included in the repository's Windows CI job. That workflow has been added but was not run as part of this local verification. Web layout verification is not an Android/iOS device run.

The SDK archives used for historical checks were verified against Microsoft's published SHA-512 metadata. The .NET 7 runtime was taken from the verified SDK archive after the standalone runtime archive failed the published checksum; the unverified archive was not executed.
