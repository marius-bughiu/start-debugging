---
title: "How to serve static files from a folder outside wwwroot in ASP.NET Core"
description: "Add a second UseStaticFiles call with a PhysicalFileProvider and a RequestPath. Why MapStaticAssets can't do it, the absolute-path and content-root traps, dot files and unknown extensions, publishing the folder, and putting it behind authorization. Tested on ASP.NET Core 10."
pubDate: 2026-10-26
template: how-to
tags:
  - "aspnet-core"
  - "aspnet-core-10"
  - "static-files"
  - "dotnet"
---

**Short answer:** register a second static file middleware that points at the other folder: `app.UseStaticFiles(new StaticFileOptions { FileProvider = new PhysicalFileProvider(Path.Combine(builder.Environment.ContentRootPath, "MyStaticFiles")), RequestPath = "/files" })`. A request for `/files/hello.txt` then returns `MyStaticFiles/hello.txt`, while `wwwroot` keeps working through `MapStaticAssets()` or the default `UseStaticFiles()`. The path you give `PhysicalFileProvider` must be absolute and must exist when the app starts, the folder is not published unless you add it to the project file, and anything this middleware serves is public unless you place it after `UseAuthorization()`. Every result below comes from a real app on ASP.NET Core 10 (SDK 10.0.302); the static file APIs involved have not changed since .NET 6 and work the same on .NET 11.

## Why wwwroot is the only folder served by default

ASP.NET Core has two separate ideas that people tend to merge: the **content root** and the **web root**. The content root is the base directory of the app (where `appsettings.json` lives). The web root is the folder that static file serving looks at, and it defaults to `{ContentRoot}/wwwroot`. Nothing outside the web root is reachable over HTTP unless you explicitly hand another folder to the middleware. That is a security feature, not an oversight: your `appsettings.json`, your `.cs` files and your `bin` folder all live under the content root, and none of them should ever be downloadable.

Since .NET 9 the templates no longer call `UseStaticFiles()` at all. They call `MapStaticAssets()`, which serves files from a manifest the build generates, with compression and fingerprinting baked in. The Microsoft docs are explicit that this endpoint-based approach only handles assets the build knows about, and that "serve files outside of the web root directory" is one of the features that still requires the static file middleware. So in a current template there is no existing `UseStaticFiles` call to tweak. You add a new one.

I confirmed this with a scratch app. With only `app.MapStaticAssets()` in the pipeline, `/root.txt` (in `wwwroot`) returns 200 and every file in a sibling `MyStaticFiles` folder returns 404, no matter which URL you try.

## The minimal working setup

Here is the project layout used throughout this post:

```text
StaticDemo/
  Program.cs
  StaticDemo.csproj
  wwwroot/
    root.txt
  MyStaticFiles/
    hello.txt
    index.html
    app.apk
    .hidden.txt
    .well-known/
      assetlinks.json
      acme-challenge/
        abc
```

And the complete `Program.cs`:

```csharp
// .NET 10, ASP.NET Core 10 (SDK 10.0.302)
using Microsoft.Extensions.FileProviders;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapStaticAssets();   // wwwroot, from the build manifest

app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(
        Path.Combine(builder.Environment.ContentRootPath, "MyStaticFiles")),
    RequestPath = "/files"
});

app.MapGet("/", () => "Hello World!");
app.Run();
```

The two properties do different jobs:

1. `FileProvider` decides **where on disk** the middleware looks. `PhysicalFileProvider` wraps a directory; anything under it, including subfolders, is a candidate.
2. `RequestPath` decides **which URL prefix** maps to that directory. With `/files`, a request for `/files/hello.txt` is resolved to `MyStaticFiles/hello.txt`. Requests that don't start with `/files` are ignored by this middleware instance and passed down the pipeline.

Running it and hitting a few URLs with curl gives:

```text
200 text/plain        /root.txt
200 text/plain        /files/hello.txt
200 text/html         /files/index.html
200 application/json  /files/.well-known/assetlinks.json
404                   /hello.txt
404                   /files
404                   /files/app.apk
404                   /files/.hidden.txt
404                   /files/.well-known/acme-challenge/abc
```

The first five are what you would expect. The four 404s at the bottom are where most of the confusion comes from, and each has a different cause. We will get to them below.

You can stack as many `UseStaticFiles` calls as you like, each with its own provider and prefix. Each instance only reacts to its own `RequestPath`, so order between them matters only if two prefixes overlap.

## Three exceptions you will hit while wiring it up

All three of these throw at startup, which is good: you find them on the first run rather than in production. Here are the exact messages from ASP.NET Core 10.

**A relative path.** `new PhysicalFileProvider("MyStaticFiles")` throws:

```text
System.ArgumentException: The path must be absolute. (Parameter 'root')
```

`PhysicalFileProvider` never resolves relative paths for you. Combine with `ContentRootPath`, `AppContext.BaseDirectory`, or use a fully qualified path such as `/var/app-data/uploads`.

**A folder that doesn't exist.** Point it at a missing directory and you get:

```text
System.IO.DirectoryNotFoundException: /srv/StaticDemo/Nope/
```

This is common for upload folders that are created lazily by the first upload. Create the directory before building the provider:

```csharp
// .NET 10
var uploads = Path.Combine(builder.Environment.ContentRootPath, "uploads");
Directory.CreateDirectory(uploads); // no-op if it already exists

app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(uploads),
    RequestPath = "/uploads"
});
```

**A malformed `RequestPath`.** `RequestPath = "files"` throws `ArgumentException: The path in 'value' must start with '/'.` and `RequestPath = "/files/"` throws `ArgumentException: Request path must not end in a slash`. Use exactly one leading slash and no trailing one.

## The content root trap after publishing

`ContentRootPath` sounds like "the folder where my app lives", but for `WebApplication.CreateBuilder` it defaults to the **current working directory** of the process. During `dotnet run` those are the same thing. After publishing, they often are not.

I published the demo and launched it from its parent directory with `dotnet app/pub/StaticDemo.dll`. The output:

```text
ContentRoot=/srv/sf WebRoot=
THROWN System.IO.DirectoryNotFoundException: /srv/sf/MyStaticFiles/
```

The app looked for `MyStaticFiles` next to wherever the shell happened to be, not next to the DLL. A systemd unit without `WorkingDirectory=`, a scheduled task, or a container whose `WORKDIR` differs from the publish folder will all do this. There are two fixes:

```csharp
// .NET 10: option 1, pin the content root to the app's folder
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory
});
```

```csharp
// .NET 10: option 2, leave the content root alone and anchor only this folder
var folder = Path.Combine(AppContext.BaseDirectory, "MyStaticFiles");
```

Option 1 also fixes `wwwroot` and `appsettings.json` lookups, which suffer from the same problem. If you host on IIS, the ASP.NET Core Module already sets the working directory correctly; if your app [fails to start on IIS with HTTP Error 500.30](/2026/08/fix-http-error-500-30-aspnet-core-app-failed-to-start-on-iis/), a `DirectoryNotFoundException` from a provider like this one is worth checking in the stdout log.

## Make sure the folder is actually published

The second publishing problem is quieter. A plain `dotnet publish -c Release -o pub` of the demo produced this:

```text
pub/wwwroot/root.txt
pub/wwwroot/root.txt.br
pub/wwwroot/root.txt.gz
(no pub/MyStaticFiles at all)
```

The Web SDK treats `wwwroot/**` as publishable content and compresses it for `MapStaticAssets`. A folder with a name it doesn't know is just a set of `None` items, which are not copied. Add an item to the project file:

```xml
<!-- StaticDemo.csproj, .NET 10 SDK -->
<ItemGroup>
  <Content Include="MyStaticFiles\**" CopyToPublishDirectory="PreserveNewest" />
</ItemGroup>
```

After that, `pub/MyStaticFiles` contains the whole tree, including the dot files and subfolders. Note that those files do not get the build-time `.br`/`.gz` variants or fingerprinted URLs that `wwwroot` gets; the static file middleware serves them as-is. If you need compression on that path, add [response compression middleware](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) in front of it. If the difference between what lands in `bin` and what lands in the publish folder is fuzzy, [dotnet build vs dotnet publish](/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) walks through it.

Skip this step entirely if the folder is runtime data that lives outside the deployment (an uploads volume, a network share, a mounted Docker volume). In that case use an absolute path from configuration instead of a path relative to the app:

```csharp
// .NET 10, appsettings.json: { "Media": { "Root": "/mnt/media" } }
var mediaRoot = builder.Configuration["Media:Root"]
    ?? throw new InvalidOperationException("Media:Root is not configured.");

app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(mediaRoot),
    RequestPath = "/media"
});
```

## Why some files still return 404

Back to the four 404s from the first test. They are three separate mechanisms.

**`/files` with no file name.** The static file middleware only serves files. It does not map a folder URL to `index.html`. Swap `UseStaticFiles` for `UseFileServer` with the same provider and prefix, which chains default documents and static files:

```csharp
// .NET 10
app.UseFileServer(new FileServerOptions
{
    FileProvider = new PhysicalFileProvider(
        Path.Combine(builder.Environment.ContentRootPath, "MyStaticFiles")),
    RequestPath = "/files"
});
```

With that, `/files` returns `301` to `/files/`, and `/files/` returns `index.html` as `text/html`. Directory browsing stays off unless you set `EnableDirectoryBrowsing = true`, which you almost never want on a folder with real data in it.

**`app.apk` and `acme-challenge/abc`: unknown extensions.** The middleware looks up the file extension in `FileExtensionContentTypeProvider`. If there is no mapping, it returns 404 rather than guess a content type. `.apk` isn't in the default table and a file with no extension has nothing to look up. Add the mappings you need:

```csharp
// .NET 10
using Microsoft.AspNetCore.StaticFiles;

var types = new FileExtensionContentTypeProvider();
types.Mappings[".apk"] = "application/vnd.android.package-archive";

app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(folder),
    RequestPath = "/files",
    ContentTypeProvider = types
});
```

`ServeUnknownFileTypes = true` with a `DefaultContentType` also works, and in my test it made both `app.apk` and the extensionless ACME token return 200 as `application/octet-stream`. The docs call it a security risk, and they're right: it turns every file in the folder into a download. Use it only for a folder that contains nothing but files meant to be public, such as a dedicated ACME challenge directory.

**`.hidden.txt`: the exclusion filter.** `PhysicalFileProvider` defaults to `ExclusionFilters.Sensitive`, which hides files whose name starts with a dot, plus files with the Hidden or System attribute. That filter applies to the **file name**, not to every segment of the path: `/files/.well-known/assetlinks.json` returned 200, because the file name itself doesn't start with a dot. Only when I passed `ExclusionFilters.None` did `.hidden.txt` come back with a 200:

```csharp
// .NET 10
using Microsoft.Extensions.FileProviders.Physical;

new PhysicalFileProvider(folder, ExclusionFilters.None);
```

Be careful with that one. With `ExclusionFilters.None` plus `ServeUnknownFileTypes`, a stray `.env` file in the folder was served too. If you only need `.well-known/*` for Android app links, Apple's `apple-app-site-association`, or Let's Encrypt, the default filter is already fine; what usually breaks those is the missing content type, not the dot.

## Moving the web root instead of adding a folder

Sometimes you don't want a second folder; you want `public/` instead of `wwwroot/`. That's a different setting. The obvious-looking call does not work in the minimal hosting model:

```csharp
// .NET 10: throws at startup
builder.WebHost.UseWebRoot("public");
```

```text
System.NotSupportedException: The web root changed from ".../wwwroot/" to ".../public/".
Changing the host configuration using WebApplicationBuilder.WebHost is not supported.
Use WebApplication.CreateBuilder(WebApplicationOptions) instead.
```

Do what the message says:

```csharp
// .NET 10
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    WebRootPath = "public"
});
```

With that, `/pub.txt` was served from `public/` and `/root.txt` from `wwwroot` returned 404. The docs add one caveat for `Development`: if both folders contain a file with the same name, the static web assets system can still serve the `wwwroot` copy during development, so delete duplicates when you make the switch. When a whole folder collides with another source of static web assets instead, you get the build error covered in [conflicting assets with the same target path](/2026/09/fix-conflicting-assets-with-the-same-target-path-in-aspnetcore-10/).

## Serving two folders under the same URL space

If you want `/hello.txt` to come from `MyStaticFiles` with no prefix, alongside the `wwwroot` files, combine providers instead of adding a second middleware:

```csharp
// .NET 10
app.Environment.WebRootFileProvider = new CompositeFileProvider(
    app.Environment.WebRootFileProvider,
    new PhysicalFileProvider(Path.Combine(builder.Environment.ContentRootPath, "MyStaticFiles")));

app.UseStaticFiles();
```

In the test, `/root.txt` and `/hello.txt` both returned 200. The first provider wins when both contain the same path. This only affects consumers that read `WebRootFileProvider` at runtime, such as `UseStaticFiles()` with no options; `MapStaticAssets` works from its build manifest and won't pick the extra folder up.

## Putting the folder behind authorization

The static file middleware does no authorization checks. Anything it can see is public, including the folder you just added. To protect it, the documented recipe is to require an authenticated user by default and run that middleware after `UseAuthorization`:

```csharp
// .NET 10
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.FileProviders;

builder.Services.AddAuthentication(/* your scheme */);
builder.Services.AddAuthorization(options =>
{
    options.FallbackPolicy = new AuthorizationPolicyBuilder()
        .RequireAuthenticatedUser()
        .Build();
});

var app = builder.Build();

app.MapStaticAssets().AllowAnonymous();   // keep public assets public
app.UseAuthentication();
app.UseAuthorization();

app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(
        Path.Combine(builder.Environment.ContentRootPath, "PrivateFiles")),
    RequestPath = "/private"
});
```

If access depends on the file (only the owner of an invoice can download it), the middleware is the wrong tool. Write an endpoint that checks the user and returns `TypedResults.PhysicalFile(path, contentType)`, and validate that the resolved path stays inside your root folder so a crafted file name can't walk out of it. The same endpoint pattern is the starting point for [streaming large files without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/).

## Related

- [How to stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/), for files that need per-request logic.
- [Fix: Conflicting assets with the same target path after upgrading to the .NET 10 SDK](/2026/09/fix-conflicting-assets-with-the-same-target-path-in-aspnetcore-10/), the build-side failure when static asset sources overlap.
- [What is the difference between dotnet build and dotnet publish?](/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/), useful when the folder exists locally but not on the server.
- [How to add response compression to an ASP.NET Core 11 API](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/), since files outside `wwwroot` don't get build-time compression.
- [Fix: HTTP Error 500.30 ASP.NET Core app failed to start on IIS](/2026/08/fix-http-error-500-30-aspnet-core-app-failed-to-start-on-iis/), where a startup `DirectoryNotFoundException` often surfaces.

## Sources

- [Static files in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/static-files?view=aspnetcore-10.0), Microsoft Learn: serving files outside the web root, `WebRootPath`, authorization, `ServeUnknownFileTypes`.
- [Map static files in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/map-static-files?view=aspnetcore-10.0), Microsoft Learn: what `MapStaticAssets` covers.
- [`PhysicalFileProvider`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.fileproviders.physicalfileprovider) and [`ExclusionFilters`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.fileproviders.physical.exclusionfilters), .NET API reference.
- [`FileExtensionContentTypeProvider`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.staticfiles.fileextensioncontenttypeprovider), .NET API reference.
- [Default and fallback authorization policies](https://learn.microsoft.com/en-us/aspnet/core/security/authorization/policies#default-and-fallback-policies), Microsoft Learn.
