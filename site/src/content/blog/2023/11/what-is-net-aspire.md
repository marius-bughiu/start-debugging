---
title: "What is .NET Aspire?"
description: ".NET Aspire is a comprehensive, cloud-oriented framework designed for creating scalable, observable, and production-grade distributed applications. It was introduced in preview part of the .NET 8 release. The framework is provided through a set of NuGet packages, each addressing different aspects of cloud-native application development, which are typically structured as a network of microservices rather…"
pubDate: 2023-11-14
updatedDate: 2023-11-16
tags:
  - "aspire"
  - "net"
---
.NET Aspire is a comprehensive, cloud-oriented framework designed for creating scalable, observable, and production-grade distributed applications. It was introduced in preview part of the .NET 8 release.

The framework is provided through a set of NuGet packages, each addressing different aspects of cloud-native application development, which are typically structured as a network of microservices rather than a single, large codebase, and rely heavily on a variety of services like databases, messaging systems, and caching solutions.

## Orchestration

Orchestration in the context of cloud-native applications involves the synchronization and administration of various components. .NET Aspire enhances this process by simplifying the setup and integration of different segments of a cloud-native application. It offers high-level abstractions for effectively handling aspects like service discovery, environmental variables, and configurations for containers, thus eliminating the need for intricate low-level coding. These abstractions ensure uniform configuration procedures across applications composed of multiple components and services.

With .NET Aspire, orchestration addresses key areas such as:

-   **Application composition:** This involves defining the .NET projects, containers, executable files, and cloud-based resources that constitute the application.
-   **Service discovery and management of connection strings:** The application host is responsible for seamlessly incorporating accurate connection strings and service discovery details, thereby enhancing the development process.

For instance, .NET Aspire enables the creation of a local Redis container resource and the setup of the corresponding connection string in a “frontend” project with minimal coding, utilizing just a couple of helper methods.

```cs
// Create a distributed application builder given the command line arguments.
var builder = DistributedApplication.CreateBuilder(args);

// Add a Redis container to the application.
var cache = builder.AddRedisContainer("cache");

// Add the frontend project to the application and configure it to use the 
// Redis container, defined as a referenced dependency.
builder.AddProject<Projects.MyFrontend>("frontend")
       .WithReference(cache);
```

## Components

.NET Aspire components, available as NuGet packages, are crafted to streamline the integration with widely-used services and platforms like Redis and PostgreSQL. These components address various aspects of cloud-native application development by offering uniform configuration setups, including the implementation of health checks and telemetry features.

Each of these components is designed to seamlessly integrate with the .NET Aspire orchestration framework. They have the ability to automatically propagate their configurations across dependencies, based on the relationships defined in .NET project and package references. This means that if a component, say Example.ServiceFoo, depends on another, Example.ServiceBar, then Example.ServiceFoo automatically adopts the necessary configurations from Example.ServiceBar to facilitate their intercommunication.

To illustrate, let’s consider the usage of the .NET Aspire Service Bus component in a coding scenario.

```cs
builder.AddAzureServiceBus("servicebus");
```

The `AddAzureServiceBus` method in .NET Aspire addresses several key functions:

1.  It establishes a `ServiceBusClient` as a singleton within the Dependency Injection (DI) container, enabling the connection to Azure Service Bus.
2.  This method allows for the configuration of `ServiceBusClient`, which can be done directly in the code or through external configuration settings.
3.  Additionally, it activates relevant health checks, logging, and telemetry features specifically tailored for Azure Service Bus, ensuring efficient monitoring and maintenance.

## Tooling

Applications developed with .NET Aspire adhere to a uniform structure, established by the default .NET Aspire project templates. Typically, a .NET Aspire application is composed of at least three distinct projects:

1.  **Foo**: This is the initial application, which can be a standard .NET project like Blazor UI or Minimal API. As the application grows, more projects can be added, and their orchestration is managed through the Foo.AppHost and Foo.ServiceDefaults projects.
2.  **Foo.AppHost**: The AppHost project oversees the high-level orchestration of the application. This includes assembling different components such as APIs, service containers, and executables, and configuring their interconnectivity and communication.
3.  **Foo.ServiceDefaults**: This project houses the default configuration settings for a .NET Aspire application. These settings, which include aspects like health checks and OpenTelemetry configurations, can be tailored and expanded as needed.

To assist in starting with this structure, two primary .NET Aspire starter templates are offered:

-   **.NET Aspire Application**: A fundamental starter template, it includes just the Foo.AppHost and Foo.ServiceDefaults projects, providing the basic framework to build upon.
-   **.NET Aspire Starter Application**: A more comprehensive template, this not only contains the Foo.AppHost and Foo.ServiceDefaults projects but also comes with pre-set UI and API projects. These additional projects are pre-configured with service discovery and other standard .NET Aspire functionalities.

### Read next:

-   [How to install .NET Aspire](/2023/11/how-to-install-net-aspire/)
-   [Build your first .NET Aspire application](/2023/11/getting-started-with-net-aspire/)
