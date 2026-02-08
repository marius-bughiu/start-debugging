---
title: "WPF hardware acceleration in RDP"
description: "WPF applications use by default software rendering when accessed over remote desktop, even if the system has hardware rendering capabilities. With .NET 8, a new option is introduced which allows you to opt into hardware acceleration when using the Remote Desktop Protocol. This can result in improved performance and an overall more responsive application. You…"
pubDate: 2023-10-09
updatedDate: 2023-11-05
tags:
  - "net"
  - "net-8"
  - "wpf"
---
WPF applications use by default software rendering when accessed over remote desktop, even if the system has hardware rendering capabilities. With .NET 8, a new option is introduced which allows you to opt into hardware acceleration when using the Remote Desktop Protocol. This can result in improved performance and an overall more responsive application.

You can opt in by setting the `Switch.System.Windows.Media.EnableHardwareAccelerationInRdp` flag to `true` inside a _`runtimeconfig.json`_ file, like so:

```json
{
  "configProperties": {
    "Switch.System.Windows.Media.EnableHardwareAccelerationInRdp": true
  }
}
```

You can also configure this setting in your project by adding a `RuntimeHostConfigurationOption`, example below:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <RuntimeHostConfigurationOption Include="Switch.System.Windows.Media.EnableHardwareAccelerationInRdp" Value="true" />
  </ItemGroup>
</Project>
```

Note: the hardware acceleration in RDP option cannot be configured through `DOTNET_` environment variables.
