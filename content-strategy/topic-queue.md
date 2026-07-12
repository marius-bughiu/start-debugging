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
- How to use query splitting to avoid a cartesian explosion in EF Core 11 → slug: 2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11
- How to dispose controllers in Flutter to avoid memory leaks (`AnimationController`, `TextEditingController`, `ScrollController`) → slug: 2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks
- How to handle network errors gracefully in a Flutter app → slug: 2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app
- How to show loading and error states with `AsyncValue` and `StateNotifier` in Flutter Riverpod → slug: 2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod
- How to use HybridCache in ASP.NET Core 11 with Redis as the L2 cache → slug: 2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache
- How to organize minimal API endpoints with `MapGroup` in ASP.NET Core 11 → slug: 2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11
- How to validate request bodies in minimal APIs without controllers in ASP.NET Core 11 → slug: 2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11
- How to expose OpenAPI without Swashbuckle in ASP.NET Core 11 → slug: 2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11
- How to use EF Core 11 interceptors for auditing → slug: 2026/06/how-to-use-ef-core-11-interceptors-for-auditing
- How to persist state across the Blazor static-to-interactive render boundary in .NET 11 → slug: 2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11
- How to initialize a `Future` so `FutureBuilder` doesn't recreate it on every rebuild in Flutter → slug: 2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter
- How to seed data with `UseSeeding` and `UseAsyncSeeding` in EF Core 11 → slug: 2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11
- How to seed a many-to-many relationship in EF Core 11 → slug: 2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11
- How to configure CORS for a JWT-protected API in ASP.NET Core 11 → slug: 2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11
- How to validate a JWT's issuer, audience, and lifetime in ASP.NET Core 11 → slug: 2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11
- How to use `BuildContext` safely after an `await` in Flutter → slug: 2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter
- How to set up nested routes and deep links with `go_router` in Flutter → slug: 2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter
- How to register and resolve keyed services in .NET 11 dependency injection → slug: 2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection
- How to do keyset (cursor) pagination in EF Core 11 → slug: 2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11
- How to map and query JSON columns in EF Core 11 → slug: 2026/06/how-to-map-and-query-json-columns-in-ef-core-11
- How to declare extension properties in C# 14 → slug: 2026/06/how-to-declare-extension-properties-in-csharp-14
- How to propagate a `CancellationToken` through async methods in .NET 11 → slug: 2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11
- How to time out an async operation with `CancellationTokenSource.CancelAfter` in C# → slug: 2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp
- How to implement and consume `IAsyncDisposable` with `await using` in C# → slug: 2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp
- How to nest a `ListView` inside a `Column` in Flutter without an unbounded-height error → slug: 2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error
- How to mix a `ListView` and a `GridView` in one scroll view with slivers in Flutter → slug: 2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter
- How to set up JWT bearer authentication in a minimal API in ASP.NET Core 11 → slug: 2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11
- How to customize minimal API validation error responses with `IProblemDetailsService` in ASP.NET Core 11 → slug: 2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11
- How to use named query filters for soft delete and multi-tenancy in EF Core 11 → slug: 2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11
- How to check `Ref.mounted` before using `ref` after an async gap in Flutter Riverpod 3.0 → slug: 2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3
- How to customize the OpenAPI document with `AddOperationTransformer` and `AddSchemaTransformer` in ASP.NET Core 11 → slug: 2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11
- How to add output caching to a minimal API in ASP.NET Core 11
- How to map a complex type instead of an owned entity in EF Core 11
- How to configure table-per-hierarchy (TPH) inheritance mapping in EF Core 11
- How to guard `setState` with the `mounted` check after an async gap in Flutter
- How to cancel a `StreamSubscription` in `dispose` to avoid a setState-after-dispose crash in Flutter
- How to add a `Hero` animation between two screens in Flutter
- How to return a typed `Results<T1, T2>` union from a minimal API endpoint in ASP.NET Core 11
- How to add response compression to an ASP.NET Core 11 API

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
- Fix: `setState() or markNeedsBuild() called during build` in Flutter → slug: 2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter
- Fix: `ObjectDisposedException: Cannot access a disposed context instance` in a fire-and-forget task → slug: 2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance
- Fix: `A TextEditingController was used after being disposed` in Flutter → slug: 2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter
- Fix: `RenderBox was not laid out` in Flutter → slug: 2026/06/fix-renderbox-was-not-laid-out-in-flutter
- Fix: `InvalidOperationException: A render mode is not supported by the parent component's render mode` in Blazor → slug: 2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor
- Fix: `The configured execution strategy 'SqlServerRetryingExecutionStrategy' does not support user-initiated transactions` in EF Core → slug: 2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions
- Fix: `The entity type 'X' requires a primary key to be defined` in EF Core 11 → slug: 2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined
- Fix: `The antiforgery token could not be decrypted` in ASP.NET Core → slug: 2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore
- Fix: `HttpRequestException: The SSL connection could not be established` with HttpClient → slug: 2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient
- Fix: `Bad state: Cannot use "ref" after the widget was disposed` in Flutter Riverpod → slug: 2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod
- Fix: `Looking up a deactivated widget's ancestor is unsafe` in Flutter → slug: 2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter
- Fix: `Do not use BuildContexts across async gaps` in Flutter → slug: 2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter (duplicate of existing post)
- Fix: `LateInitializationError: Field has not been initialized` in Flutter → slug: 2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter
- Fix: `Null check operator used on a null value` in Flutter → slug: 2026/06/fix-null-check-operator-used-on-a-null-value-in-flutter
- Fix: ASP.NET Core JWT returns 401 even with a valid token → slug: 2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token
- Fix: `405 Method Not Allowed` instead of 401 with JWT bearer in ASP.NET Core → slug: 2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore
- Fix: `The seed entity for entity type 'X' cannot be added because a non-zero value is required for property 'Id'` in EF Core → slug: 2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property
- Fix: `FOREIGN KEY constraint failed` when deleting an entity in EF Core 11 → slug: 2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11
- Fix: `No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered` → slug: 2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered
- Fix: `The LINQ expression could not be translated` in EF Core 11 → slug: 2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11
- Fix: `The required column 'X' was not present in the results of a 'FromSql' operation` in EF Core 11 → slug: 2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11
- Fix: `Vertical viewport was given unbounded height` in Flutter → slug: 2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error (same intent as existing post)
- Fix: `RenderViewport expected a RenderSliver` in a Flutter `CustomScrollView` → slug: 2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview
- Fix: `Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets` in Flutter → slug: 2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter
- Fix: `Cannot provide both a color and a decoration` in a Flutter `Container` → slug: 2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container
- Fix: `415 Unsupported Media Type` from a minimal API endpoint in ASP.NET Core 11 → slug: 2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11
- Fix: `CS9035: Required member 'X' must be set in the object initializer` in C# → slug: 2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer
- Fix: Riverpod 3.0 throws `ProviderException` instead of the original error → slug: 2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error
- Fix: `The property 'X' could not be mapped, because it is of type 'Y' which is not a supported primitive type or a valid entity type` in EF Core
- Fix: `setState() called after dispose()` in Flutter
- Fix: `Bad state: Cannot get a field on a disposed resource` in Flutter
- Fix: `System.InvalidOperationException: Headers are read-only, response has already started` in ASP.NET Core
- Fix: `413 Request Entity Too Large` when uploading a file to an ASP.NET Core endpoint
- Fix: `ScaffoldMessenger.of() was called with a context that does not contain a Scaffold` in Flutter
- Fix: `type 'Null' is not a subtype of type 'X'` in Dart
- Fix: `MissingPluginException: No implementation found for method` in Flutter
- Fix: `CS8618: Non-nullable property 'X' must contain a non-null value when exiting constructor` in C#

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
- `BackgroundService` vs `IHostedService` vs Hangfire for background jobs in .NET 11 → slug: 2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11
- EF Core `ExecuteUpdate` vs loading entities and `SaveChanges` → slug: 2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges
- Provider vs Riverpod vs Bloc for Flutter state management in 2026 → slug: 2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026
- HybridCache vs `IMemoryCache` vs `IDistributedCache` in .NET 11 → slug: 2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11
- `FutureBuilder`/`StreamBuilder` vs Riverpod `AsyncValue` in Flutter → slug: 2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter
- `AsNoTracking` vs `AsNoTrackingWithIdentityResolution` in EF Core 11 → slug: 2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11
- Minimal API validation vs FluentValidation in ASP.NET Core 11 → slug: 2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11
- JWT vs cookie authentication in ASP.NET Core 11 → slug: 2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11
- `HasData` vs `UseSeeding` for seeding data in EF Core 11 → slug: 2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11
- Keyset pagination vs `OFFSET`/`FETCH` paging in EF Core 11 → slug: 2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11 (same intent as existing post)
- `go_router` vs `auto_route` vs Navigator 2.0 in Flutter → slug: 2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter
- Named query filters vs a single global query filter in EF Core 11 → slug: 2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11
- `shrinkWrap` vs `Expanded` vs slivers for long lists in Flutter → slug: 2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter
- Complex types vs owned entities in EF Core 11
- Output caching vs response caching in ASP.NET Core 11
- TPH vs TPT vs TPC inheritance mapping in EF Core 11
- Typed results (`Results<>`) vs `IResult` vs `IActionResult` in ASP.NET Core 11
- `riverpod` vs `flutter_riverpod` vs `hooks_riverpod`: which package do I actually need?

## Migration / upgrade

- Migrate from .NET 8 to .NET 11: the full checklist → slug: 2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist
- Migrate from .NET Framework 4.8 to .NET 11 in 2026 → slug: 2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026
- Migrate from Xamarin.Forms to MAUI 11 → slug: 2026/05/migrate-from-xamarin-forms-to-maui-11
- Migrate from Newtonsoft.Json to System.Text.Json in a large codebase → slug: 2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase
- Migrate from MediatR to plain dependency injection → slug: 2026/05/migrate-from-mediatr-to-plain-dependency-injection
- Migrate from AutoMapper to source-generated mapping → slug: 2026/05/migrate-from-automapper-to-source-generated-mapping
- Migrate EF Core 6 to EF Core 11: breaking changes that actually bite → slug: 2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes
- Migrate from Serilog to OpenTelemetry logging in .NET 11 → slug: 2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11
- Migrate from in-process Azure Functions to isolated worker → slug: 2026/06/migrate-from-in-process-azure-functions-to-isolated-worker
- Migrate a Blazor Server app to Blazor United in .NET 11 → slug: 2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11
- Migrate from `ValueTask<T>` back to `Task<T>`: when and why → slug: 2026/06/migrate-from-valuetask-back-to-task-when-and-why
- Migrate from `IWebHostBuilder` to `WebApplication.CreateBuilder` → slug: 2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder
- Migrate from `System.Web.HttpContext` to `Microsoft.AspNetCore.Http.HttpContext` → slug: 2026/06/migrate-from-system-web-httpcontext-to-aspnetcore-httpcontext
- Migrate a Flutter 2 app to Flutter 3.x: null safety checklist → slug: 2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist
- Migrate from GetX to Riverpod in Flutter → slug: 2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod (duplicate of existing post)
- Migrate from `provider` to `riverpod` in Flutter → slug: 2026/06/migrate-from-provider-to-riverpod-in-flutter
- Migrate from Swashbuckle to the built-in OpenAPI document generation in .NET 11 → slug: 2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11
- Migrate from `FutureBuilder` to a Riverpod `AsyncNotifier` in Flutter → slug: 2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter
- Migrate from `HasData` seeding to `UseAsyncSeeding` in EF Core 11 → slug: 2026/07/migrate-from-hasdata-seeding-to-useasyncseeding-in-ef-core-11
- Migrate from Riverpod 2.x to Riverpod 3.0 in Flutter → slug: 2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter
- Migrate a minimal API from manual validation checks to built-in validation in ASP.NET Core 11 → slug: 2026/07/migrate-a-minimal-api-from-manual-validation-to-built-in-validation-in-aspnetcore-11
- Migrate Swashbuckle `IOperationFilter` and `ISchemaFilter` to OpenAPI transformers in .NET 11
- Migrate from owned entities to complex types in EF Core 11
- Migrate a `setState` `StatefulWidget` to a Riverpod `Notifier` in Flutter

## What is / concept

- What is `IAsyncEnumerable<T>` and when should I use it? → slug: 2026/06/what-is-iasyncenumerable-and-when-should-i-use-it
- What is a source generator and when do I need one? → slug: 2026/06/what-is-a-source-generator-and-when-do-i-need-one
- What is Native AOT and what does it cost me? → slug: 2026/06/what-is-native-aot-and-what-does-it-cost-you
- What is `ValueTask<T>` and when is it worth it? → slug: 2026/06/what-is-valuetask-and-when-is-it-worth-it
- What is `Span<T>` and when does it make my code faster? → slug: 2026/06/what-is-span-and-when-does-it-make-my-code-faster
- What is the `DynamicallyAccessedMembers` attribute? → slug: 2026/06/what-is-the-dynamicallyaccessedmembers-attribute
- What is trim-safe code and how do I write it? → slug: 2026/07/what-is-trim-safe-code-and-how-do-i-write-it
- What is the difference between `dotnet build` and `dotnet publish`? → slug: 2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish
- What is the difference between `dotnet watch` and `dotnet run`? → slug: 2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run
- What is the `IHostedService` contract and when do I use it? → slug: 2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it
- What is a tiered compilation and how do I reason about it? → slug: 2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it
- What is PGO in .NET and do I need to opt in? → slug: 2026/07/what-is-pgo-in-dotnet-and-do-i-need-to-opt-in
- What is the `W^X` flag and why does Native AOT need it?
- What is the difference between a Dart isolate and a thread?
- What is a Flutter `Key` and when does omitting it cause bugs?
- What is the difference between `IHostedService` and `BackgroundService`?
- What is a cache stampede and how does HybridCache prevent it?
- What is an EF Core interceptor and when do I need one?
- What is a Blazor render mode and which one runs my component?
- What is the difference between `ref.watch` and `ref.read` in Riverpod?
- What is the `use_build_context_synchronously` lint in Flutter?
- What is a keyed service in .NET dependency injection?
- What is a sliver in Flutter and when do I need a `CustomScrollView`?
- What is `IProblemDetailsService` and how does it shape error responses in ASP.NET Core 11?
- What is a complex type in EF Core 11 and how is it different from an owned entity?
- What is an OpenAPI transformer in ASP.NET Core and when do I need one?

---

## Consumed

<!-- entries move here with `→ slug: YYYY/MM/<slug>` annotations once a post is written -->
