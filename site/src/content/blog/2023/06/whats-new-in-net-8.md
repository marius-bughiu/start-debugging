---
title: "What’s new in .NET 8"
description: ".NET 8 was released on November 14, 2023 as an LTS (Long Term Support) version, meaning it will continue to receive support, updates, and bug fixes for at least three years from its release date. As usual, .NET 8 brings support for a new version of the C# languange, namely C# 12. Check out our dedicated page…"
pubDate: 2023-06-10
updatedDate: 2023-11-15
tags:
  - "net"
  - "net-8"
---
.NET 8 was released on **November 14, 2023** as an LTS (Long Term Support) version, meaning it will continue to receive support, updates, and bug fixes for at least three years from its release date.

As usual, .NET 8 brings support for a new version of the C# languange, namely C# 12. Check out our dedicated page covering [what’s new in C# 12](/2023/06/whats-new-in-c-12/).

Let’s dive into the list of changes and new features in .NET 8:

-   [.NET Aspire (preview)](/2023/11/what-is-net-aspire/)
    -   [Prerequisites](/2023/11/how-to-install-net-aspire/)
    -   [Getting started](/2023/11/getting-started-with-net-aspire/)
-   .NET SDK changes
    -   [‘dotnet workload clean’ command](/2023/09/dotnet-workload-clean/)
    -   ‘dotnet publish’ and ‘dotnet pack’ assets
-   Serialization
    -   [snake\_case and kebab-case JSON naming policies](/2023/08/net-8-json-serialize-property-names-using-snake-case-and-kebab-case/)
    -   [Handle missing members during serialization](/2023/09/net-8-handle-missing-members-during-json-deserialization/)
    -   [Deserialize into read-only properties](/2023/09/net-8-deserialize-into-read-only-properties/)
    -   [Include non-public properties in serialization](/2023/09/net-8-include-non-public-members-in-json-serialization/)
    -   [Add modifiers to existing IJsonTypeInfoResolver instances](/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/)
    -   Streaming deserialization: [From JSON to AsyncEnumerable](/2023/10/httpclient-get-json-as-asyncenumerable/)
    -   JsonNode: [deep clone, deep copy](/2023/10/deep-cloning-and-deep-equality-of-a-jsonnode/) and [other API updates](/2023/10/jsonnode-net-8-api-updates/)
    -   [Disable default reflection-based serialization](/2023/10/system-text-json-disable-reflection-based-serialization/)
    -   [Add/Remove TypeInfoResolver to existing JsonSerializerOptions instance](/2023/10/add-remove-typeinforesolver-to-existing-jsonserializeroptions/)
-   Core .NET libraries
    -   [FrozenDictionary – performance comparison](/2023/08/net-8-performance-dictionary-vs-frozendictionary/)
    -   Methods for working with randomness – [GetItems<T>()](/2023/11/c-randomly-choose-items-from-a-list/) and [Shuffle<T>()](/2023/10/c-how-to-shuffle-an-array/)
-   Extension libraries
-   Garbage collection
-   Source generator for configuration binding
-   Reflection improvements
    -   No more reflection: meet [UnsafeAccessorAttribute](/2023/10/unsafe-accessor/) (see [performance benchmarks](/2023/11/net-8-performance-unsafeaccessor-vs-reflection/))
    -   [Updating `readonly` fields](/2023/06/whats-new-in-net-8/)
-   Native AOT support
-   Performance improvements
-   .NET container images
-   .NET on Linux
-   Windows Presentation Foundation (WPF)
    -   [Hardware acceleration in RDP](/2023/10/wpf-hardware-acceleration-in-rdp/)
    -   [Open Folder Dialog](/2023/10/wpf-open-folder-dialog/)
        -   Additional dialog options ([ClientGuid](/2023/10/wpf-individual-dialog-states-using-clientguid/), [RootDirectory](/2023/10/wpf-limit-openfiledialog-folder-tree-to-a-certain-folder/), [AddToRecent](/2023/10/wpf-prevent-file-dialog-selection-from-being-added-to-recents/) and CreateTestFile)
-   NuGet
