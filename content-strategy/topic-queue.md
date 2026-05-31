# Long-tail topic queue

Source of high-intent evergreen topics for `content-strategy/evergreen-prompt.md`. When a topic is picked up, the evergreen lane appends `→ slug: YYYY/MM/<slug>` to that line so it is not re-picked.

**Target depth**: 1500-2500 words per post.
**Target intent**: solve a real search query (error fix, comparison, migration, "how do I X").
**Refill rule**: never let this file drop below **30 unconsumed items**. Weekly top-up task pulls from Google "People Also Ask", StackOverflow's active .NET tag, and the previous week's GSC "page 2" queries.

---

## How-to

- How to return multiple values from a method in C# 14 → slug: 2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14
- How to use records with EF Core 11 correctly → slug: 2026/04/how-to-use-records-with-ef-core-11-correctly
- How to use `IAsyncEnumerable<T>` with EF Core → slug: 2026/04/how-to-use-iasyncenumerable-with-ef-core-11
- How to cancel a long-running Task in C# without deadlocking → slug: 2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking
- How to read a large CSV in .NET 11 without running out of memory → slug: 2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory
- How to generate strongly-typed client code from an OpenAPI spec in .NET 11 → slug: 2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11
- How to stream a file from an ASP.NET Core endpoint without buffering → slug: 2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering
- How to use Channels instead of BlockingCollection in C# → slug: 2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp
- How to write a custom `JsonConverter` in System.Text.Json → slug: 2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json
- How to profile a .NET app with `dotnet-trace` and read the output → slug: 2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output
- How to add a global exception filter in ASP.NET Core 11 → slug: 2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11
- How to unit-test code that uses `HttpClient` → slug: 2026/04/how-to-unit-test-code-that-uses-httpclient
- How to mock `DbContext` without breaking change tracking → slug: 2026/04/how-to-mock-dbcontext-without-breaking-change-tracking
- How to reduce cold-start time for a .NET 11 AWS Lambda → slug: 2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda
- How to use Native AOT with ASP.NET Core minimal APIs → slug: 2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis
- How to warm up EF Core's model before the first query → slug: 2026/04/how-to-warm-up-ef-core-model-before-the-first-query
- How to upload a large file with streaming to Azure Blob Storage → slug: 2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage
- How to implement refresh tokens in ASP.NET Core Identity → slug: 2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity
- How to add OpenAPI authentication flows to Swagger UI in .NET 11 → slug: 2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11
- How to share validation logic between server and Blazor WebAssembly → slug: 2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly
- How to detect when a file finishes being written to in .NET → slug: 2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet
- How to use `SearchValues<T>` correctly in .NET 11 → slug: 2026/04/how-to-use-searchvalues-correctly-in-dotnet-11
- How to write a source generator for `INotifyPropertyChanged` → slug: 2026/04/how-to-write-a-source-generator-for-inotifypropertychanged
- How to use the new `System.Threading.Lock` type in .NET 11 → slug: 2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11
- How to add per-endpoint rate limiting in ASP.NET Core 11 → slug: 2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11
- How to set up structured logging with Serilog and seq in .NET 11 → slug: 2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11
- How to use OpenTelemetry with .NET 11 and a free backend → slug: 2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend
- How to write integration tests against a real SQL Server with Testcontainers → slug: 2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers
- How to detect N+1 queries in EF Core 11 → slug: 2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11
- How to use compiled queries with EF Core for hot paths → slug: 2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths
- How to write a MAUI app that runs on Windows and macOS only (no mobile) → slug: 2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only
- How to use Tailwind CSS with Blazor WebAssembly in .NET 11 → slug: 2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11
- How to implement drag-and-drop in MAUI 11 → slug: 2026/05/how-to-implement-drag-and-drop-in-maui-11
- How to support dark mode correctly in a MAUI app → slug: 2026/05/how-to-support-dark-mode-correctly-in-a-maui-app
- How to package a MAUI app for the Microsoft Store → slug: 2026/05/how-to-package-a-maui-app-for-the-microsoft-store
- How to target multiple Flutter versions from one CI pipeline → slug: 2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline
- How to add platform-specific code in Flutter without plugins → slug: 2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins
- How to write a Dart isolate for CPU-bound work → slug: 2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work
- How to migrate a Flutter app from GetX to Riverpod → slug: 2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod
- How to profile jank in a Flutter app with DevTools → slug: 2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools
- How to convert `T[]` to `ReadOnlyMemory<T>` (implicit operator and explicit constructor) → slug: 2026/05/how-to-convert-array-to-readonlymemory-in-csharp
- How to set the accent color in a Flutter app with Material 3 `ColorScheme` → slug: 2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme
- How to migrate a high-performance Xamarin.Forms `ListView` to MAUI `CollectionView` → slug: 2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview
- How to use scoped services inside a `BackgroundService` in ASP.NET Core 11 → slug: 2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11
- How to run fire-and-forget work safely in ASP.NET Core with `BackgroundService` → slug: 2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice
- How to use `ExecuteUpdate` and `ExecuteDelete` for bulk writes in EF Core 11 → slug: 2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11
- How to use query splitting to avoid a cartesian explosion in EF Core 11
- How to dispose controllers in Flutter to avoid memory leaks (`AnimationController`, `TextEditingController`, `ScrollController`)
- How to handle network errors gracefully in a Flutter app
- How to show loading and error states with `AsyncValue` and `StateNotifier` in Flutter Riverpod

## Fix / error

- Fix: `System.InvalidOperationException: No connection string named 'DefaultConnection' could be found` → slug: 2026/05/fix-no-connection-string-named-defaultconnection
- Fix: `The instance of entity type X cannot be tracked because another instance with the same key value is already being tracked` → slug: 2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value
- Fix: `A second operation was started on this context instance before a previous operation completed` → slug: 2026/05/fix-second-operation-was-started-on-this-context-instance
- Fix: `The JSON value could not be converted to System.DateTime` → slug: 2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime
- Fix: `TaskCanceledException: A task was canceled` in HttpClient → slug: 2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient
- Fix: `System.Text.Json.JsonException: The JSON value could not be converted` → slug: 2026/05/fix-jsonexception-the-json-value-could-not-be-converted
- Fix: `Unable to resolve service for type X while attempting to activate Y` → slug: 2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate
- Fix: `Cannot consume scoped service from singleton` → slug: 2026/05/fix-cannot-consume-scoped-service-from-singleton
- Fix: `PlatformNotSupportedException: Operation is not supported on this platform` in Native AOT → slug: 2026/05/fix-platformnotsupportedexception-in-native-aot
- Fix: `The type or namespace name could not be found` after adding a project reference → slug: 2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference
- Fix: `MSB3027: Could not copy X to Y` during build → slug: 2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count
- Fix: `dotnet ef migrations add` fails with "Unable to create an object of type DbContext" → slug: 2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext
- Fix: `The instance of entity type is being tracked` in EF Core on re-attach → slug: 2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value (same intent as existing post)
- Fix: `RZ10012: Found markup element with unexpected name` in Blazor → slug: 2026/05/fix-rz10012-found-markup-element-with-unexpected-name-blazor
- Fix: `InvalidOperationException: Synchronous operations are disallowed` in ASP.NET Core → slug: 2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed
- Fix: `System.IO.FileNotFoundException: Could not load file or assembly` in a published app → slug: 2026/05/fix-could-not-load-file-or-assembly-in-published-app
- Fix: `The command 'dotnet' could not be found` on CI → slug: 2026/05/fix-the-command-dotnet-could-not-be-found-on-ci
- Fix: `Keyset does not exist` when calling a Win32 API from .NET → slug: 2026/05/fix-keyset-does-not-exist-when-calling-win32-api-from-dotnet
- Fix: `A possible object cycle was detected` when serializing with System.Text.Json → slug: 2026/05/fix-possible-object-cycle-was-detected-system-text-json
- Fix: `SqlException: Timeout expired` during EF Core migrations → slug: 2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations
- Fix: `Gradle build failed to produce an .apk file` in MAUI Android → slug: 2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android
- Fix: `Provisioning profile doesn't include the currently selected device` in MAUI iOS → slug: 2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios
- Fix: `Unable to find a valid iOS Simulator runtime` during MAUI build → slug: 2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build
- Fix: `DartError: RenderFlex overflowed` in Flutter → slug: 2026/05/fix-renderflex-overflowed-in-flutter
- Fix: `Unhandled Exception: FormatException: Unexpected character` when parsing JSON in Dart → slug: 2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart
- Fix: `Version solving failed` in pubspec.yaml → slug: 2026/05/fix-version-solving-failed-in-pubspec-yaml
- Fix: `Failed to build iOS app` with Xcode 16 and Flutter 3.x → slug: 2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x
- Fix: `AndroidX conflict` during Flutter Android build → slug: 2026/05/fix-androidx-conflict-during-flutter-android-build
- Fix: Flutter `background_fetch` plugin requires `minSdkVersion 21` → slug: 2026/05/fix-flutter-background-fetch-requires-minsdkversion-21
- Fix: `MissingMethodException` / `framework_version=6.0.0` when launching a .NET 6 binary → slug: 2026/05/fix-framework-version-6-0-0-when-launching-dotnet-6-binary
- Fix: C# 14 "the resolution for this invocation has changed... breaking change in overload resolution with spans" → slug: 2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans
- Fix: `setState() or markNeedsBuild() called during build` in Flutter
- Fix: `ObjectDisposedException: Cannot access a disposed context instance` in a fire-and-forget task
- Fix: `A TextEditingController was used after being disposed` in Flutter
- Fix: `RenderBox was not laid out` in Flutter

## Vs / comparison

- `async void` vs `async Task` in C#: when each is correct → slug: 2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct
- EF Core 11 vs Dapper for bulk inserts: real benchmark → slug: 2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark
- `record` vs `class` vs `struct` in C#: a decision matrix → slug: 2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix
- `IEnumerable<T>` vs `IAsyncEnumerable<T>` vs `IQueryable<T>` → slug: 2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp
- `ConfigureAwait(false)` vs default in .NET 11: does it still matter? → slug: 2026/05/configureawait-false-vs-default-in-dotnet-11
- Minimal APIs vs controllers in ASP.NET Core 11 → slug: 2026/05/minimal-apis-vs-controllers-in-aspnetcore-11
- Native AOT vs ReadyToRun vs plain JIT → slug: 2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11
- `System.Text.Json` vs `Newtonsoft.Json` in 2026 → slug: 2026/05/system-text-json-vs-newtonsoft-json-in-2026
- `HttpClient` vs `HttpClientFactory` vs `Refit` → slug: 2026/05/httpclient-vs-httpclientfactory-vs-refit
- MediatR vs plain service classes after MediatR's license change → slug: 2026/05/mediatr-vs-plain-service-classes-in-2026
- EF Core compiled queries vs raw SQL vs Dapper → slug: 2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper
- Polly vs resilience handlers in .NET 11 → slug: 2026/05/polly-vs-resilience-handlers-in-dotnet-11
- `lock` vs `Monitor` vs `SemaphoreSlim` vs `System.Threading.Lock` → slug: 2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp
- `Task.Run` vs `Task.Factory.StartNew` vs `ThreadPool.QueueUserWorkItem` → slug: 2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem
- `List<T>` vs `Span<T>` vs `ReadOnlySpan<T>`: when to reach for which → slug: 2026/05/list-vs-span-vs-readonlyspan-in-csharp
- `StringBuilder` vs string interpolation in .NET 11 → slug: 2026/05/stringbuilder-vs-string-interpolation-in-dotnet-11
- `Parallel.ForEach` vs `Parallel.ForEachAsync` vs `Task.WhenAll` → slug: 2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall
- Azure Functions isolated worker vs in-process in .NET 11 → slug: 2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11
- Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11 → slug: 2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11
- MAUI vs Avalonia vs Uno in 2026 → slug: 2026/05/maui-vs-avalonia-vs-uno-in-2026
- Flutter vs React Native vs MAUI for a new mobile project in 2026 → slug: 2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026
- Dart records vs Freezed classes → slug: 2026/05/dart-records-vs-freezed-classes
- `BackgroundService` vs `IHostedService` vs Hangfire for background jobs in .NET 11
- EF Core `ExecuteUpdate` vs loading entities and `SaveChanges`
- Provider vs Riverpod vs Bloc for Flutter state management in 2026

## Migration / upgrade

- Migrate from .NET 8 to .NET 11: the full checklist → slug: 2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist
- Migrate from .NET Framework 4.8 to .NET 11 in 2026 → slug: 2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026
- Migrate from Xamarin.Forms to MAUI 11 → slug: 2026/05/migrate-from-xamarin-forms-to-maui-11
- Migrate from Newtonsoft.Json to System.Text.Json in a large codebase → slug: 2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase
- Migrate from MediatR to plain dependency injection → slug: 2026/05/migrate-from-mediatr-to-plain-dependency-injection
- Migrate from AutoMapper to source-generated mapping → slug: 2026/05/migrate-from-automapper-to-source-generated-mapping
- Migrate EF Core 6 to EF Core 11: breaking changes that actually bite
- Migrate from Serilog to OpenTelemetry logging in .NET 11
- Migrate from in-process Azure Functions to isolated worker
- Migrate a Blazor Server app to Blazor United in .NET 11
- Migrate from `ValueTask<T>` back to `Task<T>`: when and why
- Migrate from `IWebHostBuilder` to `WebApplication.CreateBuilder`
- Migrate from `System.Web.HttpContext` to `Microsoft.AspNetCore.Http.HttpContext`
- Migrate a Flutter 2 app to Flutter 3.x: null safety checklist
- Migrate from GetX to Riverpod in Flutter
- Migrate from `provider` to `riverpod` in Flutter

## What is / concept

- What is `IAsyncEnumerable<T>` and when should I use it?
- What is a source generator and when do I need one?
- What is Native AOT and what does it cost me?
- What is `ValueTask<T>` and when is it worth it?
- What is `Span<T>` and when does it make my code faster?
- What is the `DynamicallyAccessedMembers` attribute?
- What is trim-safe code and how do I write it?
- What is the difference between `dotnet build` and `dotnet publish`?
- What is the difference between `dotnet watch` and `dotnet run`?
- What is the `IHostedService` contract and when do I use it?
- What is a tiered compilation and how do I reason about it?
- What is PGO in .NET and do I need to opt in?
- What is the `W^X` flag and why does Native AOT need it?
- What is the difference between a Dart isolate and a thread?
- What is a Flutter `Key` and when does omitting it cause bugs?
- What is the difference between `IHostedService` and `BackgroundService`?

---

## Consumed

<!-- entries move here with `→ slug: YYYY/MM/<slug>` annotations once a post is written -->
