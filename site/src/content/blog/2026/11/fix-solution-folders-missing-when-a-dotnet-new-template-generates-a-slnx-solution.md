---
title: "Fix: solution folders missing when a dotnet new template generates a .slnx solution"
description: "In .slnx a solution folder is a path: Folder Name must start and end with '/', so write Name=\"/source/\", not Name=\"source\". Nest Project inside Folder; a SolutionFolder attribute is silently ignored. Verified with dotnet new on SDK 10.0.302 and 11.0.100."
pubDate: 2026-11-12
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-cli"
  - "slnx"
  - "templates"
  - "dotnet-10"
  - "dotnet-11"
---

In a `.slnx` file a solution folder is identified by a path, not a display name: `<Folder Name="...">` must start and end with `/`. Change `<Folder Name="source">` to `<Folder Name="/source/">`, keep each `<Project>` nested inside its `<Folder>`, and the folders come through `dotnet new` intact. The template engine copies `.slnx` files verbatim apart from `#if` blocks and `sourceName` replacement, so whatever is wrong in the generated solution was already wrong in the template. Everything below was run with `dotnet new` on .NET SDK 10.0.302 and SDK 11.0.100 (macOS arm64), and both behaved the same.

## The error in context

The symptom people search for is "my solution folders disappeared after migrating the template from `.sln` to `.slnx`". The underlying error only shows up when something actually parses the file. `dotnet build` on the generated solution prints it:

```text
Acme.slnx(2,4): error MSB4025: The project file could not be loaded.
  Microsoft.VisualStudio.SolutionPersistence.Model.SolutionException:
  Solution folder path 'source' must start and end with '/'. (Parameter 'path')
   ---> Microsoft.VisualStudio.SolutionPersistence.Model.SolutionArgumentException:
  Solution folder path 'source' must start and end with '/'. (Parameter 'path')
     at Microsoft.VisualStudio.SolutionPersistence.Model.SolutionModel.AddFolder(String path)
     at Microsoft.VisualStudio.SolutionPersistence.Serializer.Xml.XmlDecorators.XmlFolder.AddToModel(...)
     ...
     at Microsoft.Build.Construction.SolutionFile.ParseUsingNewParser()
```

`dotnet sln list` fails the same way, with `Invalid solution '.../Acme.slnx'. One or more errors occurred. (Solution folder path 'source' must start and end with '/'.)`. A [Stack Overflow answer on this exact question](https://stackoverflow.com/questions/79895902) reports the same message when the file is opened in Visual Studio 2022.

The second shape of the problem has no error at all: the solution builds, every project is listed, but they all sit at the root of Solution Explorer. That is what you get from the `SolutionFolder="source"` attribute workaround that circulates as an answer, and it is covered below.

## Why the folders disappear

Two separate facts combine here.

**`dotnet new` does not understand solutions.** The template engine treats `SomeSourceProject.slnx` as a text file. It applies the default operations for the file's extension (conditional comments and `sourceName` / symbol replacement) and writes the result. It never parses the XML as a solution, never validates folder paths, and never rewrites `<Folder>` elements. If the template file contains `<Folder Name="source">`, the generated file contains `<Folder Name="source">`.

**The `.slnx` parser is strict about folder paths.** Both the SDK and Visual Studio read `.slnx` through `Microsoft.VisualStudio.SolutionPersistence`, and its `SolutionModel.AddFolder` requires the folder path to begin and end with `/`. In `.sln` a solution folder was a fake project entry with a display name and a GUID; nesting lived in a separate `NestedProjects` section. In `.slnx` there are no GUIDs, so the folder's identity *is* its path, and `/source/libs/` means "folder `libs` inside folder `source`". A bare `source` is not a path, so the file is rejected outright rather than repaired.

When you migrate a template by hand-translating the old `.sln` (where you saw `"source"` as the folder's name), writing `Name="source"` is the natural mistake. `dotnet sln migrate` and `dotnet new sln` never produce that form, which is why solutions created by tools are fine and hand-edited templates are not.

## Minimal repro

Template layout, built for this post:

```text
tpl/
  .template.config/template.json
  SomeSourceProject.slnx
  source/SomeSourceProject/SomeSourceProject.csproj
  source/SomeSourceProject.Optional/SomeSourceProject.Optional.csproj
  tests/SomeSourceProject.Tests/SomeSourceProject.Tests.csproj
```

The broken solution file in the template:

```xml
<!-- .NET SDK 10.0.302 / 11.0.100: BROKEN, folder names are not paths -->
<Solution>
  <Folder Name="source">
    <Project Path="source/SomeSourceProject/SomeSourceProject.csproj" />
    <!--#if (withOptional)-->
    <Project Path="source/SomeSourceProject.Optional/SomeSourceProject.Optional.csproj" />
    <!--#endif-->
  </Folder>
  <Folder Name="tests">
    <Project Path="tests/SomeSourceProject.Tests/SomeSourceProject.Tests.csproj" />
  </Folder>
</Solution>
```

Install and instantiate:

```bash
dotnet new install ./tpl
dotnet new slnxfolders -n Acme
dotnet build Acme.slnx
```

`dotnet new` reports success, and the generated `Acme.slnx` is the template with `SomeSourceProject` replaced by `Acme` and the `#if` block removed. `dotnet build` then fails with the `MSB4025` error above. Nothing in the template engine warned about it, because the engine never looked.

## Fix 1: write folder names as paths

Change every `Name` to a slash-delimited path. This is the whole fix for the common case:

```xml
<!-- .NET SDK 10.0.302 / 11.0.100: SomeSourceProject.slnx inside the template -->
<Solution>
  <Folder Name="/source/">
    <Project Path="source/SomeSourceProject/SomeSourceProject.csproj" />
    <!--#if (withOptional)-->
    <Project Path="source/SomeSourceProject.Optional/SomeSourceProject.Optional.csproj" />
    <!--#endif-->
  </Folder>
  <Folder Name="/tests/">
    <Project Path="tests/SomeSourceProject.Tests/SomeSourceProject.Tests.csproj" />
  </Folder>
</Solution>
```

The `template.json` that goes with it needs nothing `.slnx`-specific:

```json
{
  "$schema": "http://json.schemastore.org/template",
  "author": "Start Debugging",
  "identity": "SD.SlnxFolders",
  "name": "SLNX folders repro",
  "shortName": "slnxfolders",
  "sourceName": "SomeSourceProject",
  "tags": { "type": "solution" },
  "symbols": {
    "withOptional": { "type": "parameter", "datatype": "bool", "defaultValue": "false" }
  },
  "sources": [
    {
      "modifiers": [
        { "condition": "(!withOptional)", "exclude": [ "source/SomeSourceProject.Optional/**" ] }
      ]
    }
  ]
}
```

Output of `dotnet new slnxfolders -n Acme --withOptional true` on both SDKs:

```xml
<Solution>
  <Folder Name="/source/">
    <Project Path="source/Acme/Acme.csproj" />
    <Project Path="source/Acme.Optional/Acme.Optional.csproj" />
  </Folder>
  <Folder Name="/tests/">
    <Project Path="tests/Acme.Tests/Acme.Tests.csproj" />
  </Folder>
</Solution>
```

And the check that the folders really exist in the solution model, not just in the XML:

```text
$ dotnet sln Acme.slnx list --solution-folders
Solution Folder(s)
------------------
source
tests

$ dotnet build Acme.slnx
Build succeeded.
```

With `--withOptional false` the optional project line and its directory are both gone and the build still succeeds.

`dotnet sln list` without `--solution-folders` only prints project paths, so it cannot tell you whether folders survived. Use the flag (available on SDK 10) when you script a template smoke test.

## Fix 2: let a post action build the folders for you

If you would rather not maintain the folder structure by hand, ship an empty solution and let `dotnet new` add the projects through the built-in "add projects to solution" post action. It runs `dotnet sln add` with `--solution-folder`, and `dotnet sln` writes correct paths by construction:

```json
{
  "$schema": "http://json.schemastore.org/template",
  "identity": "SD.SlnxPostAction",
  "name": "SLNX post action repro",
  "shortName": "slnxpa",
  "sourceName": "SomeSourceProject",
  "tags": { "type": "solution" },
  "primaryOutputs": [
    { "path": "source/SomeSourceProject/SomeSourceProject.csproj" },
    { "path": "tests/SomeSourceProject.Tests/SomeSourceProject.Tests.csproj" }
  ],
  "postActions": [
    {
      "actionId": "D396686C-DE0E-4DE6-906D-291CD29FC5DE",
      "description": "Add source projects",
      "args": { "solutionFolder": "source", "primaryOutputIndexes": "0" },
      "continueOnError": false
    },
    {
      "actionId": "D396686C-DE0E-4DE6-906D-291CD29FC5DE",
      "description": "Add test projects",
      "args": { "solutionFolder": "tests", "primaryOutputIndexes": "1" },
      "continueOnError": false
    }
  ]
}
```

The template's `SomeSourceProject.slnx` is just `<Solution>\n</Solution>`. On SDK 10.0.302, `dotnet new slnxpa -n Acme` printed two "Successfully added project(s) to a solution file." blocks and produced:

```xml
<Solution>
  <Folder Name="/source/">
    <Project Path="source/Acme/Acme.csproj" />
  </Folder>
  <Folder Name="/tests/">
    <Project Path="tests/Acme.Tests/Acme.Tests.csproj" />
  </Folder>
</Solution>
```

Note that `solutionFolder` in the post action is a plain name (`source`); the CLI turns it into the `/source/` path. One post action per destination folder is needed, because a single post action applies one `solutionFolder` to every primary output it selects. Conditional projects are handled with a `condition` on the primary output rather than with `#if` in the solution file.

Fix 1 is simpler and keeps the solution reviewable as a file. Fix 2 is worth it when the project set is highly conditional, at the cost of a template whose solution content only exists after the post actions run (`dotnet new` ran them without prompting in this test; IDE hosts may handle post actions differently, so check the ones your team uses).

## Why the SolutionFolder attribute "works" but flattens everything

One answer on the Stack Overflow question suggests putting the folder on the project instead:

```xml
<!-- .NET SDK 10.0.302: does NOT create solution folders -->
<Solution>
  <Project Path="src/A/A.csproj" SolutionFolder="source" />
  <Project Path="tests/A.Tests/A.Tests.csproj" SolutionFolder="tests" />
</Solution>
```

`SolutionFolder` is not part of the `.slnx` schema. The parser does not reject unknown attributes, so the file loads and builds, but both projects end up at the solution root:

```text
$ dotnet sln attr.slnx list --solution-folders
No projects found in the solution.

$ dotnet sln attr.slnx list
Project(s)
----------
src/A/A.csproj
tests/A.Tests/A.Tests.csproj
```

The serializer even preserves the dead attribute when the CLI rewrites the file: after `dotnet sln attr.slnx add other/B/B.csproj` the new project went into a proper `<Folder Name="/other/">` while the two original projects kept `SolutionFolder="..."` and stayed at the root. This is the trap: a solution that builds, lists every project, and has no folders, which is exactly the "it doesn't matter if I create it with CLI, Rider or VS, the outcome is always identical" report from the question. The same answer also suggests a `specialCustomOperations` block for `**/*.slnx`; it is unnecessary, see the next section.

## Template conditionals inside .slnx

`#if` in XML comments works in `.slnx` without any custom operations. The template engine in SDK 10.0.302 ships `**/*.slnx` in its built-in list of file globs with default operations (inspecting the UTF-16 strings in `Microsoft.TemplateEngine.Orchestrator.RunnableProjects.dll` shows it next to `**/*.sln`, `**/*.*proj` and `**/*.xml`), and the repro above confirms the effect on both SDKs: `<!--#if (withOptional)-->` blocks are kept or dropped and the marker comments are removed.

A few rules that follow from the engine treating the file as text:

- **Wrap whole elements.** `#if` can remove a `<Project>` line or an entire `<Folder>...</Folder>` block: wrapping `<Folder Name="/SomeSourceProject.Extras/">` and its project in `<!--#if (withOptional)-->` produced an `/Acme.Extras/` folder with `--withOptional true` and no trace of it with `false`. Do not try to make only the `Name` attribute conditional; generate two alternative `<Folder>` elements instead.
- **An empty folder is valid.** If every project inside `/source/` is conditioned out, the generated `<Folder Name="/source/">` with no children still loads, builds, and shows `source` under `--solution-folders`. Wrap the folder itself in the same condition if you do not want an empty node in Solution Explorer.
- **Duplicate folders are not.** Splitting one folder into two `<Folder Name="/source/">` elements (say, one per `#if` branch, both kept) fails with `SolutionException: Duplicate item '/source/' of type 'Folder'.` Make the branches mutually exclusive, or put the `#if` inside a single folder.
- **`sourceName` replacement applies to the whole file.** The same test shows it: `/SomeSourceProject.Extras/` became `/Acme.Extras/`. If your template's source name appears in a folder name, the folder is renamed along with the project paths.

## Nested folders and other path rules

Everything was verified against the `.slnx` parser in SDK 10.0.302 by building each variant and listing its folders:

| `Folder Name` | Result |
| --- | --- |
| `/source/` | Valid |
| `source` | `Solution folder path 'source' must start and end with '/'` |
| `/source` | `Solution folder path '/source' must start and end with '/'` |
| `/source/libs/` (parent not declared) | Valid; `--solution-folders` lists both `source` and `source/libs` |
| `/source/` twice | `Duplicate item '/source/' of type 'Folder'` |

The parent of a nested folder is created implicitly when the file is read. If the CLI later rewrites the file (any `dotnet sln add` or `remove`), it materializes that parent as an explicit `<Folder Name="/source/" />` element, so expect that diff the first time someone adds a project to a generated solution.

Project paths are separate from folder paths. `Project Path` is a file system path relative to the `.slnx`; folder `Name` is a logical path in Solution Explorer. They often match by convention (`/source/` holds `source/...` projects), but nothing requires it. Backslashes in `Project Path` (`src\A\A.csproj`) also loaded and built on macOS in this test; forward slashes are what `dotnet sln` writes and the safer choice for templates used across operating systems.

## Gotchas and lookalikes

- **`dotnet sln add` without `--solution-folder` creates folders you did not ask for.** Adding `other/B/B.csproj` produced `<Folder Name="/other/">`, named after the project's parent directory. Pass `--in-root` to keep it at the root, or `--solution-folder` (with or without slashes: `source` and `/source/` both landed in the existing `/source/` folder) to choose one.
- **Templates that still ship `.sln`.** If the template's solution is a classic `.sln`, the folder rules are the old GUID-based ones and none of this applies. Starting with .NET 10, `dotnet new sln` creates a `.slnx` by default (SDK 10.0.302 wrote `Demo.slnx` containing an empty `<Solution>`), so new templates are increasingly `.slnx` whether you chose it or not.
- **IDE caches.** If you fixed the template but Visual Studio or Rider still shows a flat tree, check that you reinstalled the template (`dotnet new install ./tpl --force`). An installed template is a copy; editing the source folder does not update it until you reinstall.
- **Old SDKs.** `.slnx` support arrived in the .NET 9 SDK (9.0.200). On SDKs older than that, `dotnet build` does not know the format at all and the failure is unrelated to folders.

## Related

- The `dotnet sln` command got more capable in .NET 11, including [solution filter support in the CLI](/2026/04/dotnet-11-sln-cli-solution-filters/).
- If the template also standardizes package versions, pair it with [Central Package Management via Directory.Packages.props](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/).
- Adding orchestration to a template-generated solution is covered in [adding Aspire to an existing ASP.NET Core solution without restructuring it](/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/).
- Template parameters have their own failure modes, for example [`dotnet new api -aot`: 'aot' is not a valid option](/2023/06/dotnet-new-api-aot-aot-is-not-a-valid-option/).
- For what else changed in SDK 11.0.100 when you move a template to it, see [.NET 11 is generally available: what to change in your project](/2026/11/dotnet-11-is-generally-available-what-to-change-in-your-project/).

## Sources

- [Stack Overflow: .NET 10 Solution Template not applying Solution Folders on SLNX Solutions](https://stackoverflow.com/questions/79895902)
- [dotnet sln command reference (MS Learn)](https://learn.microsoft.com/dotnet/core/tools/dotnet-sln)
- [microsoft/vs-solutionpersistence, the library that reads and writes .slnx](https://github.com/microsoft/vs-solutionpersistence)
- [Template engine reference: template.json, sources, symbols](https://github.com/dotnet/templating/wiki/Reference-for-template.json)
- [Template engine post actions, including "Add projects to solution"](https://github.com/dotnet/templating/wiki/Post-Action-Registry)
- [Conditional processing in templates](https://github.com/dotnet/templating/wiki/Conditional-processing-and-comment-syntax)
