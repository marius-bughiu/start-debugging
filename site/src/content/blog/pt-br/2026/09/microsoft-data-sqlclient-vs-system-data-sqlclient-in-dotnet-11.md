---
title: "Microsoft.Data.SqlClient vs System.Data.SqlClient no .NET 11"
description: "Use Microsoft.Data.SqlClient. O System.Data.SqlClient está obsoleto, já emite CS0618 em todo tipo que você tocar e perde seus assets de .NET quando o .NET 8 chegar ao fim do suporte em 2026-11-10, o mesmo dia em que o .NET 11 é lançado. A diferença de recursos medida, o valor padrão de Encrypt que quebra a migração e a divisão do pacote no 7.0."
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "sql-server"
  - "migration"
lang: "pt-br"
translationOf: "2026/09/microsoft-data-sqlclient-vs-system-data-sqlclient-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-17
---

Use **`Microsoft.Data.SqlClient`**. Esta não é uma comparação disputada e não é desde 2022. O `System.Data.SqlClient` está formalmente obsoleto, a descrição do seu pacote NuGet diz literalmente "DEPRECATED - Use Microsoft.Data.SqlClient.", todo tipo público carrega `[Obsolete]` e, segundo o próprio plano em etapas da Microsoft, seus assets de .NET desaparecem quando o .NET 8 chegar ao fim do suporte em **2026-11-10**, que também é o dia em que o .NET 11 é lançado. A única decisão que resta é qual linha do `Microsoft.Data.SqlClient` adotar (7.0 ou a LTS 6.1) e como sobreviver à migração, porque os pacotes diferem em muito mais do que um namespace.

Tudo abaixo foi verificado no macOS 26.6.2 (Apple M4) com o SDK do .NET `10.0.302`, contra o `Microsoft.Data.SqlClient` 7.0.3 e o `System.Data.SqlClient` 4.9.1, as versões atuais enquanto escrevo. A seleção de assets é idêntica no `net11.0`: nenhum dos dois pacotes traz uma pasta `net10.0` ou `net11.0`, então um projeto .NET 11 resolve `runtimes/unix/lib/net9.0/Microsoft.Data.SqlClient.dll` e `runtimes/unix/lib/net8.0/System.Data.SqlClient.dll`, exatamente o que um projeto `net10.0` resolve.

## A matriz

| | `Microsoft.Data.SqlClient` 7.0.3 | `System.Data.SqlClient` 4.9.1 |
| --- | --- | --- |
| Status de suporte | STS, em desenvolvimento (7.0 GA em 2026-03-17) | Obsoleto, apenas manutenção |
| Publicado a partir de | [dotnet/SqlClient](https://github.com/dotnet/SqlClient) | [dotnet/maintenance-packages](https://github.com/dotnet/maintenance-packages) |
| Tipos públicos | 91 em 7 namespaces | 51 em 5 namespaces |
| `[Obsolete]` na API pública | Não | Sim, CS0618 em todo tipo |
| Asset de .NET mais alto | `net9.0` | `net8.0` |
| Asset de .NET removido quando | não previsto | fim do suporte do .NET 8, 2026-11-10 |
| Padrão de `Encrypt` | `true` desde 4.0 | `false` |
| Tipo da propriedade `Encrypt` | `SqlConnectionEncryptOption` | `bool` |
| TDS 8.0 / `Encrypt=Strict` | Sim desde 5.0 | Não |
| TLS 1.3 | Sim, via TDS 8.0 | Não |
| Autenticação com Microsoft Entra ID | Sim, via `Extensions.Azure` | Não |
| `SqlBatch` | Sim desde 5.2 | Não |
| Always Encrypted com enclaves seguros | Sim | Não |
| Classificação de dados / sensibilidade | Sim (6 tipos) | Não |
| Tipo `json` do SQL Server 2025 (`SqlJson`) | Sim desde 6.0 | Não |
| Tipo `vector` do SQL Server 2025 (`SqlVector<T>`) | Sim desde 6.1 | Não |
| Lógica de repetição configurável | Sim | Não |
| Palavras-chave de string de conexão | 48 | 38 |
| Saída de publicação, console hello-world | 7.35 MB / 23 assemblies | 1.07 MB / 2 assemblies |

As contagens de tipos e de palavras-chave vêm de carregar os dois assemblies em um `MetadataLoadContext` e comparar `GetExportedTypes()` e `SqlConnectionStringBuilder.GetProperties()`, não de ler notas de versão.

## O relógio da obsolescência é o argumento inteiro

A Microsoft publicou o [plano de obsolescência](https://github.com/dotnet/announcements/issues/322) em agosto de 2024, e ele é incomumente específico. A versão 5.0.0 deveria remover tudo abaixo de .NET 8 e .NET Framework 4.6.2 e adicionar `[Obsolete]` aos assets de .NET. Depois do GA do .NET 9, nada mais. Depois do fim do suporte do .NET 8, os assets de biblioteca para .NET são removidos e restam apenas os consumidores de .NET Framework 4.6.2+, atendidos pelo próprio .NET Framework e não pelo pacote. As palavras do anúncio são diretas: a Microsoft não espera atualizar o pacote de novo depois desse ponto.

O .NET 8 chega ao [fim do suporte em 2026-11-10](https://devblogs.microsoft.com/dotnet/dotnet-8-9-end-of-support/). O .NET 11 chega ao RTM no mesmo dia. Então a pergunta "qual SqlClient no .NET 11" se responde sozinha: no dia em que o .NET 11 existir como runtime suportado, o `System.Data.SqlClient` não terá nenhuma história de .NET com suporte. Ele ainda vai restaurar. Um projeto `net11.0` vai pegar tranquilamente o asset `net8.0` e rodar. Só que será código sem manutenção sentado no seu caminho de conexão.

Vale notar que o pacote desviou do plano em uma direção: o 4.9.1 saiu em 2026-02-12 com um asset `net8.0` que o plano original não prometia, e o repositório mudou para `dotnet/maintenance-packages`. Isso é manutenção, não desenvolvimento. A dependência declarada no nuspec continua sendo `runtime.native.System.Data.SqlClient.sni` **4.4.0**, uma compilação nativa de SNI de 2017.

## O que o compilador já te diz

Você não precisa acreditar no anúncio. Referencie o 4.9.1 de um projeto moderno e toque em qualquer coisa:

```csharp
// net10.0 (identical on net11.0), System.Data.SqlClient 4.9.1
using System.Data.SqlClient;

var b = new SqlConnectionStringBuilder { DataSource = "localhost", InitialCatalog = "db" };
Console.WriteLine($"Encrypt default: {b.Encrypt}");
```

```text
warning CS0618: 'SqlConnectionStringBuilder' is obsolete:
'Use the Microsoft.Data.SqlClient package instead.'
```

```text
Encrypt default: False
```

O mesmo programa contra o `Microsoft.Data.SqlClient` 7.0.3 compila com zero avisos e imprime `Encrypt default: True`. Essa única linha é a diferença de comportamento mais consequente entre os dois pacotes, e o resto deste post dedica tempo real a ela.

## A diferença que você não fecha com um shim

As 10 palavras-chave de string de conexão que só existem no `Microsoft.Data.SqlClient` não são conveniências. Comparar as propriedades de `SqlConnectionStringBuilder` dá exatamente: `Authentication`, `AttestationProtocol`, `ColumnEncryptionSetting`, `CommandTimeout`, `EnclaveAttestationUrl`, `FailoverPartnerSPN`, `HostNameInCertificate`, `IPAddressPreference`, `ServerCertificate`, `ServerSPN`. A comparação inversa é vazia: o `System.Data.SqlClient` não tem nenhuma palavra-chave que falte ao driver moderno.

Passe essas palavras-chave para o builder antigo e você tem os modos de falha que aparecem quando alguém tenta conectar uma aplicação legada ao SQL Server 2022 ou 2025:

```csharp
// System.Data.SqlClient 4.9.1
new SqlConnectionStringBuilder("Server=localhost;Encrypt=Strict");
// FormatException: String 'Strict' was not recognized as a valid Boolean.

new SqlConnectionStringBuilder("Server=localhost;Authentication=Active Directory Default");
// ArgumentException: Keyword not supported: 'authentication'.

new SqlConnectionStringBuilder("Server=localhost;HostNameInCertificate=sql.contoso.com");
// ArgumentException: Keyword not supported: 'hostnameincertificate'.

new SqlConnectionStringBuilder("Server=localhost;ServerCertificate=/etc/ssl/sql.pem");
// ArgumentException: Keyword not supported: 'servercertificate'.
```

`Encrypt=Strict` é a metade cliente do [TDS 8.0](https://learn.microsoft.com/en-us/sql/relational-databases/security/networking/tds-8), a revisão de protocolo que o SQL Server 2022 introduziu para que o handshake TLS aconteça antes do TDS em vez de dentro dele. O TDS 8.0 é o que torna o TLS 1.3 alcançável a partir de um cliente do SQL Server. O `System.Data.SqlClient` nunca foi atualizado para isso, o que significa nada de TLS 1.3 e nenhum caminho até ele. Se o seu time de segurança tem um mandato de TLS 1.3, a escolha do driver já foi feita por outra pessoa.

O mesmo vale para o Microsoft Entra ID. `Authentication=Active Directory Default`, `Active Directory Managed Identity` e afins simplesmente não são interpretados. Também não há história de token: `SqlConnection.AccessTokenCallback` é um dos membros que só existe no driver moderno, ao lado de `RetryLogicProvider`, `SspiContextProvider`, `ServerProcessId` e de toda a família `RegisterColumnEncryptionKeyStoreProviders`.

Se você está conectando ao SQL Server 2025 e quer usar o tipo de coluna nativo `json` ou colunas `vector`, `Microsoft.Data.SqlTypes.SqlJson` (6.0) e `Microsoft.Data.SqlTypes.SqlVector<T>` (6.1) são as únicas representações de cliente com suporte. O `SqlVector<T>` em particular envia vetores em uma forma binária compacta sobre TDS em vez de strings JSON. Se você está avaliando esse tipo de coluna, a [comparação entre coluna json nativa e nvarchar(max)](/pt-br/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/) cobre o lado de armazenamento da mesma decisão.

## O único argumento honesto a favor do pacote antigo, medido

O `System.Data.SqlClient` é pequeno. Essa é toda a vantagem que resta a ele, e é real. Publiquei uma aplicação de console hello-world (`dotnet publish -c Release -r osx-arm64 --self-contained false`) contra cada driver:

| Pacote | Saída de publicação | Assemblies | Pacotes transitivos |
| --- | --- | --- | --- |
| `System.Data.SqlClient` 4.9.1 | 1.07 MB | 2 | 4 |
| `Microsoft.Data.SqlClient` 7.0.3 | 7.35 MB | 23 | 22 |
| `Microsoft.Data.SqlClient` 6.1.7 | 17.3 MB | 29 | 29 |

Aquela linha do 6.1.7 é o motivo pelo qual o lançamento do 7.0 importa mesmo se você já estava no driver moderno. Comparando as duas pastas de publicação, o 7.0.3 remove `Azure.Core`, `Azure.Identity`, `Microsoft.Identity.Client`, `Microsoft.Identity.Client.Broker`, `Microsoft.Identity.Client.Extensions.Msal`, `Microsoft.Identity.Client.NativeInterop`, `System.ClientModel`, `System.Memory.Data`, `Microsoft.Bcl.AsyncInterfaces` e, o maior arquivo de toda a saída do 6.1.7, o `msalruntime_arm64.dylib` com **7.5 MB**. Um binário nativo do broker do MSAL, em uma aplicação de console que nunca se autentica em nada. A versão 7.0 moveu tudo isso para o pacote opcional `Microsoft.Data.SqlClient.Extensions.Azure`, e a saída resultante é 10.2 MB menor.

Então o `Microsoft.Data.SqlClient` ainda é cerca de 7 vezes a pegada implantada do pacote obsoleto. Se isso realmente importa para você -- uma imagem de contêiner reduzida, um binário Native AOT -- pese contra os 22 pacotes que ele também traz para o seu grafo de restauração. Isso não muda a recomendação. 6 MB de assemblies não valem uma pilha TLS sem suporte. Mas é o único número em que o pacote antigo ganha, e fingir o contrário seria desonesto.

## A virada do `Encrypt` é o que quebra a migração

A maioria das migrações de `System.Data.SqlClient` para `Microsoft.Data.SqlClient` que falham, falha aqui. O padrão antigo é `Encrypt=false`. O padrão moderno é `Encrypt=true` desde o 4.0. Strings de conexão que funcionaram por uma década começam a falhar na validação de certificado contra um SQL Server de desenvolvimento com certificado autoassinado.

A correção reflexa é `TrustServerCertificate=true`, e ela é a errada fora de uma máquina de desenvolvimento controlada: transforma a criptografia em um túnel não autenticado. O `Microsoft.Data.SqlClient` te dá duas ferramentas melhores, ambas palavras-chave que o driver antigo não tem:

```csharp
// Microsoft.Data.SqlClient 7.0.3
// The server's cert is issued to sql-prod.internal but you connect by IP or alias.
var cs = "Server=10.0.4.12,1433;Database=orders;"
       + "Encrypt=Strict;"
       + "HostNameInCertificate=sql-prod.internal;"
       + "Authentication=Active Directory Default";
```

`HostNameInCertificate` resolve o caso de nome que não bate sem desligar a validação. `ServerCertificate` aponta para um arquivo PEM ou CER específico para um servidor autoassinado ou com CA privada, de novo sem desligar a validação. Entre os dois, quase todo `TrustServerCertificate=true` real em uma base de código pode ser substituído por algo que ainda valida.

Mais uma armadilha na mesma área: `SqlConnectionStringBuilder.Encrypt` mudou de tipo, de `bool` para `SqlConnectionEncryptOption`, no 5.0. Atribuições como `builder.Encrypt = true` continuam compilando graças a uma conversão implícita, então parece compatível em nível de código-fonte. É uma quebra **binária**. Qualquer assembly que você não recompilar contra o novo driver vai lançar `MissingMethodException` em tempo de execução. Se você distribui uma biblioteca compartilhada de acesso a dados, recompile e republique, não troque só o driver por baixo. A mesma classe de erro produz o [erro Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0'](/pt-br/2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0/) quando uma cópia 6.x antiga vence a restauração.

## Mais quatro coisas que mordem durante a migração

**A autenticação com Entra agora precisa de um segundo pacote.** No 7.0, esquecer dele produz uma mensagem clara em vez de um mistério, o que é uma melhoria real:

```text
System.ArgumentException: Cannot find an authentication provider for 'ActiveDirectoryDefault'.
Install the 'Microsoft.Data.SqlClient.Extensions.Azure' NuGet package to use
Active Directory (Entra ID) authentication methods.
```

Adicione `Microsoft.Data.SqlClient.Extensions.Azure` fixado na mesma versão do driver principal. Desde o 7.0.2 o driver principal e seus pacotes acompanhantes usam números de versão alinhados, então `7.0.3` para ambos.

**Alguns tipos mudam de namespace, e nem todos.** `SqlDataRecord` e `SqlMetaData` vão de `Microsoft.SqlServer.Server` para `Microsoft.Data.SqlClient.Server`. `SqlFileStream` vai de `System.Data.SqlTypes` para `Microsoft.Data.SqlTypes`. `SqlNotificationRequest` vai de `System.Data.Sql` para `Microsoft.Data.Sql`. `OperationAbortedException` vai de `System.Data` para `Microsoft.Data`. Mas os atributos de SQL CLR ficam onde estão: `SqlFunctionAttribute`, `SqlUserDefinedTypeAttribute`, `IBinarySerialize` e o resto estão hoje no assembly do `System.Data.SqlClient` e em um pacote `Microsoft.SqlServer.Server` separado sob o driver moderno, que é por isso que esse pacote aparece na lista de transitivos. Não faça um localizar e substituir cego em `System.Data`. `CommandType`, `DbType`, `IsolationLevel`, `DataTable` e todo tipo de `System.Data.Common` ficam exatamente onde estão.

**Parâmetros de data e hora se comportam de forma diferente.** `DbType.Time` com um valor `DateTime` era aceito pelo driver antigo; o moderno quer um `TimeSpan`. `DbType.Date` com um valor `DateTime` trunca os componentes de hora em vez de enviá-los. Se você tem chamadas a `AddWithValue` em volta de colunas de data, é ali que uma mudança silenciosa de comportamento se esconde. Especifique `SqlDbType`, comprimento, precisão e escala explicitamente para tudo que importa.

**O modo globalization-invariant não tem suporte.** Se o seu contêiner define `InvariantGlobalization=true` para cortar inicialização e tamanho, o `Microsoft.Data.SqlClient` não tem suporte nessa configuração. Isso morde exatamente os times que fazem o trabalho de redução descrito acima.

E antes de declarar a migração concluída, rode `dotnet list package --include-transitive`. Remover sua referência direta não remove aquela que um ORM antigo ou um helper de SQL CLR arrasta. Dois pacotes SqlClient em um mesmo grafo compilam sem problema e depois falham no momento em que uma `SqlConnection` de um cruza para uma API que espera a do outro, porque os nomes são idênticos e os tipos não.

## Qual linha do Microsoft.Data.SqlClient adotar

| Linha | Lançada | Suporte | Fim do suporte |
| --- | --- | --- | --- |
| 7.0 (`7.0.3`) | 2026-03-17 | STS | definido pela próxima versão |
| 6.1 (`6.1.7`) | 2025-08-14 | **LTS** | 2028-08-14 |

Adote o **7.0.3** para um serviço novo em .NET 11. Você ganha o pacote 10 MB mais leve, SSPI plugável via `SspiContextProvider`, roteamento aprimorado para Azure SQL Hyperscale e paridade de `SqlClientDiagnosticListener` no .NET Framework. Adote o **6.1.7** se precisa de um compromisso de suporte com data no papel, ou se está no meio de uma migração e não consegue absorver agora a divisão do `Extensions.Azure`. Ambos suportam SQL Server 2017 até 2025, Azure SQL e Fabric. Tudo do 6.0 para baixo já está fora de suporte, incluindo a linha LTS 5.1, que terminou em 2026-01-20.

A recomendação permanece como dita no início: migre. O compilador já está avisando, a descrição do pacote já diz obsoleto e o runtime que o pacote antigo tem como alvo chega ao fim do suporte no dia em que o .NET 11 é lançado. O trabalho é uma troca de pacote, uma passada de namespaces, um olhar sério em cada `Encrypt` e `TrustServerCertificate` da sua configuração e uma recompilação de todo assembly que toca `SqlConnectionStringBuilder`. Reserve um dia para um serviço normal. É um dia muito melhor do que aquele em que um mandato de TLS 1.3 cai sobre um driver sem manutenção.

## Relacionado

- [Fix: Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0' depois de atualizar o EF Core](/pt-br/2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0/)
- [Migrar do .NET Framework 4.8 para o .NET 11 em 2026](/pt-br/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/)
- [Nível de compatibilidade do SQL Server 150 vs 160: o que muda para as consultas do EF Core 11](/pt-br/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/)
- [Coluna json nativa vs nvarchar(max) para armazenar JSON no SQL Server com EF Core 11](/pt-br/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/)
- [Fix: EF Core MigrateAsync e CanConnectAsync continuam tentando de novo em 'Login failed for user' por 60 segundos](/pt-br/2026/09/fix-migrateasync-canconnectasync-keep-retrying-on-login-failed-for-user-ef-core/)

## Fontes

- [Announcement: System.Data.SqlClient package is now deprecated](https://github.com/dotnet/announcements/issues/322), issue 322 do dotnet/announcements, com o plano de obsolescência em etapas completo.
- [Migrate from System.Data.SqlClient to Microsoft.Data.SqlClient](https://learn.microsoft.com/en-us/sql/connect/ado-net/migrate-system-data-sql-client-to-microsoft-data-sql-client), MS Learn, atualizado em 2026-09-16.
- [Microsoft.Data.SqlClient namespace and compatibility](https://learn.microsoft.com/en-us/sql/connect/ado-net/introduction-microsoft-data-sqlclient-namespace), MS Learn.
- [SqlClient driver support lifecycle](https://learn.microsoft.com/en-us/sql/connect/ado-net/sqlclient-driver-support-lifecycle), MS Learn, para as tabelas de suporte do 7.0 e do 6.1.
- [Microsoft.Data.SqlClient 7.0.0 release notes](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.0.md), dotnet/SqlClient.
- [TDS 8.0](https://learn.microsoft.com/en-us/sql/relational-databases/security/networking/tds-8), MS Learn, para a relação entre `Encrypt=Strict` e TLS 1.3.
- [.NET 8 and .NET 9 will reach end of support on November 10, 2026](https://devblogs.microsoft.com/dotnet/dotnet-8-9-end-of-support/), .NET Blog.
- [System.Data.SqlClient no NuGet](https://www.nuget.org/packages/System.Data.SqlClient), versão 4.9.1, publicada em 2026-02-12.
