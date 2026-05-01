---
title: "Como resolver o WordPress 'Missing MySQL extension' após upgrade do MultiPHP no HostGator"
description: "Resolva o erro do WordPress 'Missing MySQL extension' após atualizar o PHP via MultiPHP manager no HostGator removendo o handler obsoleto do .htaccess."
pubDate: 2020-11-06
updatedDate: 2023-11-05
tags:
  - "wordpress"
lang: "pt-br"
translationOf: "2020/11/how-to-fix-wordpress-missing-mysql-extension-after-multiphp-upgrade-on-hostgator"
translatedBy: "claude"
translationDate: 2026-05-01
---
Depois de atualizar a versão do PHP do seu site WordPress usando o MultiPHP manager para usar PHP 7, você pode se deparar com o seguinte erro:

`Your PHP installation appears to be missing the MySQL extension which is required by WordPress.`

Isso é causado por um handler obsoleto no seu arquivo `.htaccess`.

## Resolvendo

1.  [Localize o arquivo .htaccess](https://www.youtube.com/watch?v=7ZG8c8wwEbs) usando o File Manager do cPanel
2.  Crie um backup do arquivo
3.  Edite o arquivo removendo o handler obsoleto, que deve estar assim:

```plaintext
# Use PHP71 as default
AddHandler application/x-httpd-php71 .php
<IfModule mod_suphp.c>
    suPHP_ConfigPath /opt/php71/lib
</IfModule>
```

OU

```plaintext
#Use PHPedge as default
AddHandler application/x-httpd-php-edge .php
<IfModule mod_suphp.c>
    suPHP_ConfigPath /opt/phpedge/lib
</IfModule>
```

Salve o arquivo e o erro deverá desaparecer.
