---
title: "Why does EF Core forbid concurrent reads on one DbContext, even with AsNoTracking?"
description: "A read is not read-only inside a DbContext: every query mutates the shared connection, its open counter, the command and reader state, and for tracking queries the identity map. With thread-safety checks turned off on EF Core 11.0.0, parallel AsNoTracking queries on one context still failed up to 57 times in 1,000 rounds, and tracking queries left a corrupted change tracker in all but one of the rounds that finished."
pubDate: 2026-11-25
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "async"
  - "concurrency"
---

Because a "read" through EF Core is not read-only from the `DbContext`'s point of view. Even an `AsNoTracking()` query opens or reuses the context's single `DbConnection`, bumps a plain (non-atomic) open counter, creates a command and a data reader on that connection, and closes the connection again when the reader is disposed. A tracking query additionally writes every row into the identity map, which is an ordinary `Dictionary`. None of that state is synchronized, so EF Core refuses to let two operations overlap instead of locking around everything. `AsNoTracking()` removes the change-tracker writes, not the connection writes, and turning the check off with `EnableThreadSafetyChecks(false)` does not make concurrent use safe, it only removes the informative exception.

Everything below was run on EF Core 11.0.0 with `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0 (SQLitePCLRaw 3.0.5), .NET SDK 11.0.100 on the 11.0.0 runtime, macOS 27.0.1 on an Apple M4 (10 cores). The source references are from the `release/11.0` branch of [dotnet/efcore](https://github.com/dotnet/efcore). The mechanics have not changed meaningfully since EF Core 6, when `EnableThreadSafetyChecks` was added.

## The intuition that reads cannot race

The question comes up regularly, most recently as [this Stack Overflow question](https://stackoverflow.com/questions/80004368): two queries that only `SELECT` should be able to run at the same time, because nothing is being written. That reasoning is correct for an immutable object. A `DbContext` is not one. It is a unit of work that owns:

- one `DbConnection`, wrapped in `RelationalConnection`, plus the bookkeeping that decides when EF opened it and when EF should close it;
- the currently executing command and the data reader positioned on that connection;
- the `StateManager` (identity map and entity entries) behind `ChangeTracker`;
- the lazily built internal service scope that is created on first use;
- the `ConcurrencyDetector` itself.

A query touches the first two every time, and tracking queries touch the third on every row. So "only reading" from the database's perspective still means "writing" from the context's perspective.

The [EF Core documentation](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#avoiding-dbcontext-threading-issues) states the rule without the reasoning: EF Core "does not support multiple parallel operations being run on the same DbContext instance", and when concurrent access goes undetected "it can result in undefined behavior, application crashes and data corruption". The useful part is seeing which of those you actually get.

## The experiment: switch the guard off and run reads in parallel

To find out what breaks, the harness below runs `N` copies of the same query on `Task.Run` threads against one shared `DbContext`, 1,000 rounds per scenario, with a fresh context per round. It counts rounds where every query finished, every exception type, and, for tracking queries, whether the change tracker ended up in a sane state (2,000 tracked products, and both result lists pointing at the same instances, which is what identity resolution promises).

```csharp
// .NET 11, C# 14, EF Core 11.0.0, Microsoft.EntityFrameworkCore.Sqlite 11.0.0
// dotnet run -c Release -- <rounds> <parallelism>
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;

int rounds = args.Length > 0 ? int.Parse(args[0]) : 1000;
int par = args.Length > 1 ? int.Parse(args[1]) : 2;
const int Rows = 2000;
var path = Path.Combine(Path.GetTempPath(), "efconc.db");
File.Delete(path);

await using (var seed = new AppDb(path, checks: true))
{
    await seed.Database.EnsureCreatedAsync();
    for (int c = 1; c <= 10; c++) seed.Categories.Add(new Category { Id = c, Name = $"C{c}" });
    for (int i = 0; i < Rows; i++)
        seed.Products.Add(new Product { Name = $"P{i}", Price = i, CategoryId = i % 10 + 1 });
    await seed.SaveChangesAsync();
}

await using (var db = new AppDb(path, checks: true))
{
    var first = db.Products.AsNoTracking().ToListAsync();
    Console.WriteLine($"SQLite ToListAsync completed synchronously: {first.IsCompleted}");
    var second = db.Products.AsNoTracking().ToListAsync(); // no exception on SQLite
    await Task.WhenAll(first, second);
}

await Scenario("1 checks on, no-tracking", checks: true, warm: true, open: false,
    db => db.Products.AsNoTracking().ToList());
await Scenario("2 checks off, cold context, no-tracking", checks: false, warm: false, open: false,
    db => db.Products.AsNoTracking().ToList());
await Scenario("3 checks off, no-tracking", checks: false, warm: true, open: false,
    db => db.Products.AsNoTracking().ToList());
await Scenario("4 checks off, pre-opened connection, no-tracking", checks: false, warm: true, open: true,
    db => db.Products.AsNoTracking().ToList());
await Scenario("5 checks off, tracking", checks: false, warm: true, open: false,
    db => db.Products.ToList());
await Scenario("6 checks off, tracking + Include", checks: false, warm: true, open: false,
    db => db.Products.Include(p => p.Category).ToList());
await FactoryScenario();

async Task Scenario(string name, bool checks, bool warm, bool open, Func<AppDb, List<Product>> query)
{
    var errors = new Dictionary<string, int>();
    int completed = 0, badTracker = 0;
    for (int r = 0; r < rounds; r++)
    {
        var db = new AppDb(path, checks);
        if (warm) _ = db.Categories.AsNoTracking().Count(); // force lazy initialization
        if (open) db.Database.OpenConnection();
        try
        {
            var results = await Task.WhenAll(
                Enumerable.Range(0, par).Select(_ => Task.Run(() => query(db))));
            completed++;
            if (!checks && !TrackerLooksRight(db, results)) badTracker++;
        }
        catch (Exception ex) { Count(errors, ex); }
        try { await db.DisposeAsync(); } catch (Exception ex) { Count(errors, ex, "on Dispose: "); }
    }
    Console.WriteLine($"{name}: completed {completed}/{rounds}, bad tracker state {badTracker}");
    foreach (var (k, v) in errors.OrderByDescending(e => e.Value)) Console.WriteLine($"  {v,5} x {k}");
}

bool TrackerLooksRight(AppDb db, List<Product>[] results)
{
    try
    {
        int tracked = db.ChangeTracker.Entries<Product>().Count();
        if (tracked == 0) return true; // no-tracking query, nothing to check
        bool sameInstances = results.All(l => l.Zip(results[0]).All(p => ReferenceEquals(p.First, p.Second)));
        return tracked == Rows && sameInstances;
    }
    catch { return false; } // the change tracker itself throws when read
}

async Task FactoryScenario()
{
    var factory = new PooledDbContextFactory<PoolDb>(
        new DbContextOptionsBuilder<PoolDb>().UseSqlite($"Data Source={path}").Options);
    var errors = new Dictionary<string, int>();
    int completed = 0;
    for (int r = 0; r < rounds; r++)
    {
        try
        {
            await Task.WhenAll(Enumerable.Range(0, par).Select(_ => Task.Run(async () =>
            {
                await using var db = await factory.CreateDbContextAsync();
                return await db.Products.AsNoTracking().ToListAsync();
            })));
            completed++;
        }
        catch (Exception ex) { Count(errors, ex); }
    }
    Console.WriteLine($"7 one pooled context per branch, checks on: completed {completed}/{rounds}");
}

static void Count(Dictionary<string, int> errors, Exception ex, string prefix = "")
{
    var key = prefix + ex.GetType().Name + ": " + ex.Message.Split('\n')[0];
    if (key.Length > 110) key = key[..110] + "...";
    errors[key] = errors.GetValueOrDefault(key) + 1;
}

class Category { public int Id { get; set; } public string Name { get; set; } = ""; }

class Product
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public decimal Price { get; set; }
    public int CategoryId { get; set; }
    public Category? Category { get; set; }
}

class AppDb(string path, bool checks) : DbContext
{
    public DbSet<Product> Products => Set<Product>();
    public DbSet<Category> Categories => Set<Category>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) =>
        o.UseSqlite($"Data Source={path}").EnableThreadSafetyChecks(checks);
}

class PoolDb(DbContextOptions<PoolDb> options) : DbContext(options)
{
    public DbSet<Product> Products => Set<Product>();
}
```

The project file is a plain console app targeting `net11.0` with a single `PackageReference` to `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0. The queries run synchronously on thread-pool threads on purpose; the next section explains why the async version would not overlap on SQLite at all.

## Results with 2 and 8 parallel queries

Each cell is the number of rounds (out of 1,000) in which every query returned without throwing. "Bad tracker" counts completed rounds where the change tracker was wrong afterwards.

| Scenario | 2 parallel | 8 parallel |
| --- | --- | --- |
| 1. Checks on, `AsNoTracking` | 0 completed | 0 completed |
| 2. Checks off, cold context, `AsNoTracking` | 133 completed | 23 completed |
| 3. Checks off, `AsNoTracking` | 990 completed | 943 completed |
| 4. Checks off, connection pre-opened, `AsNoTracking` | 1,000 completed | 976 completed |
| 5. Checks off, tracking | 99 completed, all 99 bad tracker | 394 completed, all 394 bad tracker |
| 6. Checks off, tracking + `Include` | 247 completed, all 247 bad tracker | 290 completed, 289 bad tracker |
| 7. One pooled context per branch, checks on | 1,000 completed | 1,000 completed |

Failure rates move between runs. Earlier runs of scenario 4 at 8-way parallelism with 2,000 rounds failed 34, 12 and 2 times. Treat these as "this happens" numbers, not as a probability you can budget for.

No round in any scenario returned wrong row data that passed silently: every product that came back had the right name for its key. The damage shows up as exceptions and as a broken change tracker, which is bad enough.

## What each failure tells you about the shared state

### Scenario 1: the detector is the only reason you see a clean error

With the default settings, 996 of the 1,000 two-way rounds failed with the message everyone knows:

```text
InvalidOperationException: A second operation was started on this context instance before a previous operation completed.
```

It fired for `AsNoTracking()` queries just as it does for tracking queries, because the check does not look at tracking at all. In `ConcurrencyDetector.EnterCriticalSection` it is one `Interlocked.CompareExchange` on an `int` flag; if the flag is already set by another thread, it throws. It is a fail-fast tripwire, not a lock: nothing waits.

The other 4 rounds are more interesting. They failed with `ExecuteReader can only be called when the connection is open`, with the detector switched on. The reason is in `SingleQueryingEnumerable`: the critical section is entered inside every `MoveNext()` call, so it covers reading one row, not the whole query. The enumerator's `Dispose()`, which disposes the `RelationalDataReader`, which calls `RelationalConnection.Close()`, runs outside it. One query finishing its last row and closing the connection can therefore race with another query that just entered `MoveNext()` and is about to execute its command. The detector catches the overwhelmingly common collision and is honest about what it is: the [API docs](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.enablethreadsafetychecks) say it "detects many cases" of erroneous concurrent usage, not all of them.

### Scenario 2: the first query on a context builds its internals

A `DbContext` does not resolve its internal services in the constructor. The first operation builds them, and while that is happening the context marks itself as initializing. A second thread that arrives in that window gets:

```text
InvalidOperationException: An attempt was made to use the context instance while it is being configured.
```

That accounted for 863 of the 1,000 two-way rounds and 956 at 8-way. This is state that is mutated by the first "read" on any context, and it has nothing to do with tracking. Every other scenario warms the context with a throwaway `Count()` first so that the later failures are about the queries themselves.

### Scenario 3: AsNoTracking still shares one connection and a non-atomic counter

With checks off and a warmed context, plain no-tracking queries failed 10 times in 1,000 rounds at 2-way and 57 times at 8-way. None of the stack traces touch the change tracker. They are all on the connection:

```text
SqliteException: SQLite Error 5: 'unable to delete/modify collation sequence due to active statements'.
   at Microsoft.Data.Sqlite.SqliteConnection.Deactivate()
   at Microsoft.Data.Sqlite.SqliteConnection.Close()
   at Microsoft.EntityFrameworkCore.Storage.RelationalConnection.Close()
   at Microsoft.EntityFrameworkCore.Storage.RelationalDataReader.Dispose()
```

```text
ObjectDisposedException: Cannot access a disposed object.
   at System.Runtime.InteropServices.SafeHandle.DangerousAddRef(Boolean& success)
   at SQLitePCL.SQLite3Provider_e_sqlite3.NativeMethods.sqlite3_column_count(sqlite3_stmt stmt)
   at Microsoft.Data.Sqlite.SqliteDataReader.GetInt32(Int32 ordinal)
```

`RelationalConnection` decides whether to open and close the underlying `DbConnection` with a reference count. `Open()` checks `DbConnection.State`, opens if needed, then does `_openedCount++`. `Close()` calls `ShouldClose()`, which does `--_openedCount == 0` and only closes if EF opened the connection itself. Neither is `Interlocked`. Two threads incrementing and decrementing concurrently lose updates, the count reaches zero while the other query still has a reader open, and EF closes the connection out from under it. The statement handle is finalized, and the next `GetInt32` hits a disposed `SafeHandle`. Other runs produced `database is locked`, `another row available`, `zero terminator required`, `Invalid attempt to call GetInt32 when reader is closed`, and `NullReferenceException`, which is what "undefined behavior" looks like in practice.

### Scenario 4: pre-opening the connection narrows the race, it does not close it

If you open the connection yourself (`db.Database.OpenConnection()`), you might expect EF to stop opening and closing it per query. At 2-way parallelism that was enough to get 1,000 clean rounds. At 8-way it was not: 24 of 1,000 rounds failed, and one of the traces is EF closing the connection from `RelationalDataReader.Dispose()`. `Database.OpenConnection()` goes through the same `RelationalConnection.Open()`, so it also increments `_openedCount` and leaves `_openedInternally` set. With enough threads hammering the counter, a lost increment drops it to zero and EF closes a connection you thought you owned.

Two more caveats make this scenario look better than it is:

- `Microsoft.Data.Sqlite` lets several data readers be open on one connection, and SQLite itself serializes calls on one connection handle in its default threading mode. SQL Server without [Multiple Active Result Sets](https://learn.microsoft.com/en-us/sql/connect/ado-net/sql/multiple-active-result-sets-mars) rejects a second open reader on one connection outright ("There is already an open DataReader associated with this Connection which must be closed first"). This harness was not run against SQL Server or PostgreSQL, so the numbers here are SQLite-only.
- The two-reader overlap is not the only shared state. The command cache in `RelationalConnection` (`ReturnCommand` in the enumerator's `Dispose`) and the query context are also per-context.

### Scenarios 5 and 6: tracking queries write into a Dictionary from two threads

Tracking queries were the worst by far, which is the part the accepted Stack Overflow answer gets right. Most failures were this:

```text
InvalidOperationException: Operations that change non-concurrent collections must have exclusive access. A concurrent update was performed on this collection and corrupted its state.
```

That message is not from EF Core. It is `Dictionary<TKey, TValue>` detecting that two threads modified it at once. The identity map inside `StateManager` is a dictionary keyed by primary key, and materializing each row of a tracking query is an insert into it. Two parallel tracking queries are two threads inserting into one `Dictionary`.

Worse, the rounds that did complete were wrong afterwards. All but one of the completed rounds in scenarios 5 and 6 failed the tracker check: the two result lists contained different instances for the same key, the tracked count was off, or `ChangeTracker.Entries()` itself threw a `NullReferenceException` when the harness tried to read it. With `Include`, 3 to 11 rounds per run hit `The instance of entity type 'Category' cannot be tracked because another instance with the same key value for {'Id'} is already being tracked`, because both threads materialized category 1, both missed it in the identity map, and both tried to attach their own copy. A subsequent `SaveChanges()` on a context in that state would be working from a corrupted unit of work.

This is also why the trade-off between [`AsNoTracking` and `AsNoTrackingWithIdentityResolution`](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) does not matter for concurrency. The identity-resolution variant uses a per-query identity map rather than the context's, but the query still goes through the same shared `RelationalConnection` as scenario 3.

## Why the exact Stack Overflow code does not throw on SQLite

The question's code started two `ToListAsync()` calls without awaiting the first. On SQL Server or Npgsql, that throws the "second operation" exception immediately. On SQLite it does not, and the harness prints why:

```text
SQLite ToListAsync completed synchronously: True
```

[Microsoft.Data.Sqlite's async methods execute synchronously](https://learn.microsoft.com/en-us/dotnet/standard/data/sqlite/async). The first `ToListAsync()` has already read every row and released the detector before the second one starts, so there is no overlap to detect. That is why the experiment above uses `Task.Run` with synchronous `ToList()`: it is the only way to make two queries genuinely overlap on SQLite. If your test suite runs on SQLite and production runs on SQL Server, an un-awaited query can pass every test and throw in production.

## What to do instead

The working pattern is scenario 7: one context per concurrent branch. With a `PooledDbContextFactory`, 8 parallel no-tracking queries completed 1,000 of 1,000 rounds with thread-safety checks left on.

```csharp
// .NET 11, C# 14, EF Core 11.0.0 (AppDb here also has a DbSet<Order> Orders)
public sealed class Dashboard(IDbContextFactory<AppDb> factory)
{
    public async Task<(List<string> names, int orders)> LoadAsync(CancellationToken ct)
    {
        var namesTask = Task.Run(async () =>
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            return await db.Products.AsNoTracking().Select(p => p.Name).ToListAsync(ct);
        }, ct);

        var ordersTask = Task.Run(async () =>
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            return await db.Orders.CountAsync(ct);
        }, ct);

        await Task.WhenAll(namesTask, ordersTask);
        return (namesTask.Result, ordersTask.Result);
    }
}
```

Register it with `AddPooledDbContextFactory<AppDb>(...)` if you want recycled instances, or `AddDbContextFactory<AppDb>(...)` if your context's constructor needs scoped services. The trade-offs between those registrations, including the measured cost of creating a pooled versus unpooled context (342 ns versus about 17 microseconds on EF Core 11 RC 1), are in [the AddDbContextPool vs AddDbContextFactory comparison](/2026/10/adddbcontextpool-vs-adddbcontextfactory-for-running-ef-core-queries-in-parallel/). The same factory is how you get a context [from a singleton service in Blazor Server](/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/), where a circuit-scoped context is effectively shared across concurrent UI events.

Three rules follow from the experiment:

1. **Do not disable thread-safety checks to "allow" parallel reads.** The documented benefit is "a minor performance improvement". What you get back is the failure modes above, with no informative exception pointing at the cause. Disable it only if you have measured the detector's cost and you can prove that no code path shares a context.
2. **`AsNoTracking()` is a materialization choice, not a concurrency choice.** It removes identity-map writes. It does not remove the shared connection, its open counter, or the reader lifecycle.
3. **Parallelism in EF Core means one context per concurrent operation.** If you do not need parallelism, await each query before starting the next on the same context.

If you already have the exception and want the fix-first version with the common call-site shapes that cause it (un-awaited `AddAsync`, `Task.Run` over a request-scoped context, Polly retries reusing a context), that is covered in [the "A second operation was started on this context instance" fix guide](/2026/05/fix-second-operation-was-started-on-this-context-instance/). A related failure that often appears once people move work onto background threads is [the disposed-context `ObjectDisposedException`](/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/), which is the same ownership problem seen from the other side.

## Sources

- [Avoiding DbContext threading issues](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#avoiding-dbcontext-threading-issues), EF Core docs.
- [`DbContextOptionsBuilder.EnableThreadSafetyChecks`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.enablethreadsafetychecks), API reference.
- [Tracking vs. No-Tracking Queries](https://learn.microsoft.com/en-us/ef/core/querying/tracking), EF Core docs (identity resolution).
- [Async limitations in Microsoft.Data.Sqlite](https://learn.microsoft.com/en-us/dotnet/standard/data/sqlite/async).
- [Multiple Active Result Sets (MARS)](https://learn.microsoft.com/en-us/sql/connect/ado-net/sql/multiple-active-result-sets-mars), SqlClient docs.
- EF Core `release/11.0` source: [`ConcurrencyDetector.cs`](https://github.com/dotnet/efcore/blob/release/11.0/src/EFCore/Infrastructure/Internal/ConcurrencyDetector.cs), [`RelationalConnection.cs`](https://github.com/dotnet/efcore/blob/release/11.0/src/EFCore.Relational/Storage/RelationalConnection.cs), [`SingleQueryingEnumerable.cs`](https://github.com/dotnet/efcore/blob/release/11.0/src/EFCore.Relational/Query/Internal/SingleQueryingEnumerable.cs), [`RelationalDataReader.cs`](https://github.com/dotnet/efcore/blob/release/11.0/src/EFCore.Relational/Storage/RelationalDataReader.cs).
- The original question: [Why does DbContext prohibit concurrent read operations if reads don't modify entity state?](https://stackoverflow.com/questions/80004368) on Stack Overflow.
