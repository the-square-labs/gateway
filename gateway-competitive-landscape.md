# Gateway Competitive Landscape

Актуальность: 18 августа 2026 года.

Этот документ сравнивает Gateway с self-hosted control panels, container managers,
PaaS-платформами, server-management продуктами, Kubernetes control planes и
AI-operations решениями. Сравнение основано на публичной документации продуктов и
текущей продуктовой модели Gateway.

> [!NOTE]
> Название `dockploy` в исходном обсуждении интерпретировано как **Dokploy**.
> «Gateway заменяет» означает консолидацию основного operational workflow, а не
> полное воспроизведение каждой функции перечисленных продуктов.

## Executive Summary

Gateway — это AI-first, но не AI-dependent self-hosted infrastructure control plane
для Docker, nginx ingress, TLS, DNS, баз данных, мониторинга, логов, PKI,
автоматизации и контролируемых AI-операций.

Прямых полноценных аналогов мало, потому что большинство конкурентов закрывает
только один или два слоя:

- Portainer, Dockhand и Komodo управляют контейнерами и fleet.
- Coolify, Dokploy, Easypanel и CapRover оптимизируют Git-to-deployment workflow.
- Nginx Proxy Manager, Traefik и Pangolin отвечают за публикацию и доступ.
- Grafana, Prometheus, Loki и OpsPilot отвечают за observability.
- Rundeck, AWX и Kubiya отвечают за automation и execution.
- Smallstep CA и Vault закрывают PKI и secrets.

Основная формула категории:

> **Gateway — self-hosted AI operations control plane для реальной инфраструктуры:
> от Docker и nginx до баз данных, PKI и автоматизации, с ручным интерфейсом,
> resource-scoped RBAC и подтверждаемым исполнением.**

Короткая формула консолидации:

> **Gateway заменяет Portainer + Nginx Proxy Manager + Grafana + database panels +
> runbook automation для команд, управляющих self-hosted Docker-инфраструктурой.**

## Gateway Versus OpsPilot

Коротко: **OpsPilot наблюдает и диагностирует; Gateway управляет и изменяет
инфраструктуру.** Это соседние продукты, а не прямые аналоги.

| Категория | OpsPilot | Gateway |
|---|---|---|
| Основной класс | Hosted observability и AI SRE | Self-hosted infrastructure control plane |
| Источник данных | OpenTelemetry: метрики, логи и трейсы | Собственные mTLS-демоны, API и интеграции |
| AI-модель | Непрерывно следит, расследует алерты, группирует ситуации и запоминает контекст | Получает задачу, строит план, запрашивает подтверждение, исполняет и проверяет |
| Реальные изменения | В основном анализ и рекомендации; autonomous incident control заявлен как будущая возможность | Управляет Docker, nginx, TLS, DNS, БД, деплоями, миграциями и секретами |
| Observability | Сильная сторона: APM, distributed tracing, anomaly detection, dashboards, incidents и service catalog | Инфраструктурный monitoring, alerts и structured logging без полного OTel/APM-стека |
| Operations | Не является infrastructure resource control plane | Нативно владеет lifecycle инфраструктурных ресурсов |
| MCP | Read-only доступ к метрикам, логам и dashboards через Grafana MCP adapter | OAuth/RBAC-bound operational MCP с доступом к разрешённым действиям |
| Развёртывание | По публичной документации hosted SaaS; self-hosted edition не заявлена | Полностью self-hosted control plane с outbound mTLS-соединениями узлов |
| Основной покупатель | SRE/platform team с существующей telemetry stack | Небольшая или средняя infrastructure/platform team, управляющая серверами и сервисами |

OpsPilot Coworker сильнее Gateway в постоянной фоновой работе: расследует алерты,
выполняет scheduled checks, строит situations, переоценивает открытые проблемы и
накапливает знания о системе. При этом его Autonomous mode относится прежде всего
к мониторингу, расследованию и alerting. Самостоятельное открытие инцидентов,
назначение задач и выполнение remediation в публичной документации пока отмечено
как будущая возможность.

Gateway имеет обратный профиль. AI не анализирует весь telemetry stream
круглосуточно, зато способен провести реальное изменение через безопасную цепочку:

```text
scenario -> plan -> approve -> execute -> verify
```

Operations Console, REST API, OAuth и MCP при этом остаются работоспособными без AI.

Практический вывод:

- OpsPilot не заменяет Gateway, если клиенту нужно управлять Docker, nginx,
  сертификатами, БД и безопасно исполнять изменения.
- Gateway не заменяет OpsPilot, если клиенту нужен зрелый OpenTelemetry APM,
  distributed tracing, непрерывный RCA и incident workspace.
- Вместе продукты могут образовать цепочку `detect -> explain -> plan -> approve ->
  remediate -> verify`.

## Comparison Legend

- **●** — сильная нативная функция.
- **◐** — частичная, ограниченная, интеграционная или платная функция.
- **○** — базовый уровень.
- **—** — отсутствует или не является фокусом продукта.

Под «управлением БД» понимается lifecycle, backups, credentials или
query/explorer semantics. Возможность просто запустить образ PostgreSQL не считается
полноценным управлением БД.

Под «AI operations» понимается AI, который видит состояние платформы и планирует
или выполняет операции. Возможность задеплоить LLM-контейнер сама по себе не
считается AI operations.

## Core Competitive Matrix

| Продукт | Модель | Existing Docker | Git -> deploy | Ingress / TLS | Управление БД | Multi-node | RBAC / audit | Observability | AI operations | Основной профиль |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|---|
| **Gateway** | Self-hosted | ● | ◐ | ● | ● | ● | ● | ◐ | ● | Полный infrastructure operations control plane |
| [Portainer](https://www.portainer.io/features) | Self-hosted | ● | ● | ○ | ○ | ● | ● | ◐ | — | Docker, Swarm, Kubernetes и edge fleet |
| [Dockhand](https://dockhand.pro/) | Self-hosted | ● | ● | ○ | ○ | ● | ◐ | ◐ | — | Современная альтернатива Portainer |
| [Dokploy](https://docs.dokploy.com/docs/core/features) | Self-hosted / Cloud | ◐ | ● | ● | ● | ● | ◐ | ◐ | — | Self-hosted PaaS и Compose deployments |
| [Coolify](https://coolify.io/docs/get-started/introduction) | Self-hosted / Cloud | ◐ | ● | ● | ● | ● | ◐ | ◐ | — | Open-source альтернатива Vercel/Heroku |
| [Vercel](https://vercel.com/pricing) | SaaS | — | ● | ● | ◐ | — | ● | ● | ◐ | Managed frontend/application cloud |
| [Komodo](https://komo.do/) | Self-hosted | ● | ● | ○ | ○ | ● | ◐ | ◐ | — | Docker/Compose/Swarm fleet и build system |
| [Easypanel](https://easypanel.io/) | Self-hosted | ◐ | ● | ● | ● | ◐ | ◐ | ◐ | ○ | Упрощённый self-hosted PaaS |
| [CapRover](https://caprover.com/) | Self-hosted | ◐ | ● | ● | ○ | ◐ | ○ | ○ | — | Минималистичный Docker Swarm PaaS |
| [Cosmos Cloud](https://cosmos-cloud.io/) | Self-hosted | ● | ○ | ● | ○ | ○ | ◐ | ◐ | — | Secure homelab/small-server platform |
| [Cloudron](https://www.cloudron.io/) | Self-hosted | — | ◐ | ● | ● | ○ | ◐ | ◐ | — | Каталог управляемых self-hosted приложений |
| [Dockge](https://github.com/louislam/dockge) | Self-hosted | ● | ○ | — | — | ◐ | ○ | ○ | — | Compose-first stack manager |
| [Rancher](https://ranchermanager.docs.rancher.com/v2.14) | Self-hosted / hosted offer | — | ● | ◐ | — | ● | ● | ● | ○ | Enterprise Kubernetes management |
| [Kubiya](https://www.kubiya.ai/platform) | Hosted / Self-hosted | ◐ | ◐ | — | — | ● | ● | ◐ | ● | Enterprise agentic operations |

Dockge управляет прежде всего Docker Compose stacks, а не полным Docker resource
model. Rancher управляет Kubernetes workloads и кластерами, а не обычными Docker
Engine hosts.

## Competitive Interpretation

| Продукт | Где сильнее Gateway | Где слабее Gateway | Степень конкуренции |
|---|---|---|---|
| **Portainer** | Kubernetes, edge/IIoT, зрелость container fleet, governance policies | Нет собственного nginx/TLS/PKI/managed DB слоя и AI execution model | **Высокая** для enterprise container management |
| **Dockhand** | Лёгкая установка, polished Docker UX, GitOps, vulnerability scanning | Уже по инфраструктуре; advanced RBAC платный; нет ingress/DB/AI | **Высокая** в сегменте Docker UI |
| **Dokploy** | Git deployment, buildpacks, databases/backups, быстрый PaaS UX | Слабее existing-infrastructure management, PKI и resource governance | **Высокая** для application deployment |
| **Coolify** | Большое сообщество, one-click services, Git-first onboarding, backups | Не является глубоким operations/control-plane продуктом | **Высокая** для developers и small teams |
| **Vercel** | Git-to-production UX, preview deployments, CDN/edge и frontend observability | SaaS; не управляет серверами, Docker, nginx и БД клиента | **Высокая как альтернатива задаче**, низкая как прямой конкурент |
| **Komodo** | Declarative Git sync, builds, Compose/Swarm и прозрачная Docker-модель | Требует отдельные ingress, DB, PKI, logging и AI слои | **Очень высокая** — ближайший прямой конкурент |
| **Easypanel** | Простота, zero-downtime deploy, templates и backups | Cluster support ограничен; меньше operational depth | **Высокая** для time-to-value |
| **CapRover** | Бесплатность, простота, Docker + nginx + Swarm | Ограниченные RBAC, observability и enterprise controls | **Средняя** |
| **Cosmos Cloud** | Reverse proxy, SSO, VPN и Docker в одном простом продукте | Слабее multi-node, team governance и production operations | **Средняя**, особенно в homelab |
| **Cloudron** | App Store, автоматические обновления и backups приложений | Закрытая packaging model и слабая работа с произвольными workloads | **Средняя** |
| **Rancher** | Kubernetes, multi-cluster enterprise governance и ecosystem | Слишком тяжёлый и не решает direct Docker/nginx operations | **Высокая только при выборе Kubernetes** |
| **Kubiya** | Multi-agent automation, integrations, policy engine и remediation | Не владеет единой infrastructure resource model уровня Gateway | **Главный стратегический AI-конкурент** |

## Server Control Panel Competitors

| Продукт | Основное пересечение | Сильная сторона | Ограничение относительно Gateway |
|---|---|---|---|
| [RunCloud](https://runcloud.io/) | Серверы, nginx, Docker, БД и monitoring | Polished web-hosting operations и auto-healing | Web application hosting, не общий control plane |
| [ServerAvatar](https://serveravatar.com/docs/intro/) | Multi-server, apps, DB, backups, logs | Полный small-business hosting workflow | Меньше container fleet, PKI и automation governance |
| [Plesk](https://www.plesk.com/) | Сайты, серверы, TLS, DNS, БД и monitoring | Зрелость, extensions и hosting/customer ecosystem | Legacy-hosting ориентация |
| [Enhance](https://enhance.com/) | Multi-server cluster, placement, backups и isolation | Hosting fleet и customer lifecycle | Не Docker infrastructure platform |
| [CloudPanel](https://www.cloudpanel.io/) | nginx, приложения, SSL, БД и users | Бесплатный и простой server panel | В основном один web stack и один сервер |

Эти продукты особенно опасны в сегменте agencies, managed hosting и small business.
Их преимущество — зрелые backups, customer lifecycle, billing integrations и
готовые web-hosting workflows. Gateway сильнее там, где нужны произвольные Docker
workloads, resource-scoped RBAC, nginx fleet, PKI и контролируемая автоматизация.

## AI, Automation And Observability Competitors

| Продукт | Что закрывает | Пересечение с Gateway | Главное отличие |
|---|---|---|---|
| [OpsPilot](https://opspilot.com/) | OTel observability и AI SRE | AI investigation, monitoring и incidents | Видит и объясняет, но почти не управляет инфраструктурой |
| [Robusta](https://docs.robusta.dev/holmes_button/) | Kubernetes alerts, AI investigation и remediation | Event-driven AI operations | Только Kubernetes/Prometheus |
| [RunWhen](https://registry.runwhen.com/) | Production-safe AI skills и runbooks | Controlled execution и troubleshooting | Каталог автоматизаций поверх внешних систем |
| [Rundeck](https://www.rundeck.com/) | Runbook automation и remote runners | RBAC, delegated execution и закрытые сети | Нет собственного lifecycle/UI для Docker, nginx и БД |
| [AWX](https://github.com/ansible/awx) | Ansible UI, API и task engine | Infrastructure automation | Требует playbooks и инфраструктурную модель Ansible |
| [Pangolin](https://docs.pangolin.net/about/how-pangolin-works) | Tunnels, reverse proxy, VPN и SSO | Outbound agents, private networks и access policies | Не управляет workloads |

## Commercial Models

Цены меняются быстрее функциональности и приведены только как ориентир на дату
документа.

| Продукт | Бесплатный вариант | Платная модель |
|---|---|---|
| **Gateway** | Community | Personal $29/month, Business $189/month, Enterprise custom; цены предварительные |
| **Portainer** | Community Edition | Business Edition; коммерческое лицензирование по managed nodes |
| **Dockhand** | $0 для разрешённого non-commercial/professional use | SMB $499/host/year; Enterprise $1,499/host/year |
| **Dokploy** | Бесплатный self-hosted | Cloud от $4.50/server/month; Enterprise |
| **Coolify** | Бесплатный self-hosted | Coolify Cloud от $5/month |
| **Vercel** | Hobby $0 | Pro $20/month плюс usage; Enterprise custom |
| **Easypanel** | $0, до трёх проектов | От $10.90 до $29.90 за server/month |
| **CapRover** | Бесплатный open source | Нет обязательного коммерческого тарифа |
| **Kubiya** | Не основной публичный сегмент | Enterprise/custom |

## Gateway Replaces Product Bundles

Ниже Gateway сравнивается не с отдельным продуктом, а со связкой, которую команде
обычно приходится собирать и сопровождать самостоятельно.

| Сценарий | Связка без Gateway | Что Gateway консолидирует |
|---|---|---|
| Базовый self-hosting | **Dockhand + Nginx Proxy Manager + Uptime Kuma + pgAdmin** | Docker, ingress/TLS, monitoring и БД |
| Небольшой production SaaS | **Coolify + Portainer + Nginx Proxy Manager + Grafana + pgAdmin** | Deployments, container lifecycle, domains, TLS, monitoring и DB operations |
| Multi-server Docker | **Komodo + Pangolin + Grafana/Loki + Rundeck** | Fleet, private connectivity, observability и controlled operations |
| Infrastructure team | **Portainer BE + Rundeck + Smallstep CA + Vault + Grafana** | RBAC, automation, PKI, secrets и monitoring |
| Self-hosted PaaS | **Dokploy + Portainer + Pangolin + Uptime Kuma** | Git/deployment lifecycle, existing containers, secure exposure и health |
| Homelab/private cloud | **Cosmos Cloud + Dockge + Nginx Proxy Manager + Uptime Kuma** | Applications, Compose, proxy/TLS и monitoring |
| Web-hosting operations | **RunCloud + Portainer + Cloudflare dashboard + Grafana** | Серверы, Docker, DNS, TLS и monitoring |
| Enterprise Docker без Kubernetes | **Portainer BE + AWX + Vault + Smallstep CA + Graylog** | Container governance, automation, secrets, PKI и logs |
| AI-assisted operations | **OpsPilot + Portainer + Rundeck + Vault** | AI analysis, infrastructure context, execution и credentials |
| AI remediation | **Kubiya + Portainer + Nginx Proxy Manager + Grafana** | AI planning/execution плюс Docker, ingress и monitoring resource model |
| Kubernetes-подобный governance для обычного Docker | **Rancher + Argo CD + cert-manager + Prometheus/Grafana** | Похожий управляемый UX без обязательного внедрения Kubernetes |
| Vercel-подобный self-hosting | **Coolify или Dokploy + Cloudflare + Neon/Supabase + Better Stack** | Deployment, ingress, databases и базовые operations на собственных серверах |

### Short Battle-Card Formulations

Для Docker-аудитории:

> **Gateway заменяет Portainer + Nginx Proxy Manager + Grafana + pgAdmin + Rundeck.**

Для пользователя Coolify или Dokploy:

> **Gateway заменяет Coolify/Dokploy + отдельный Docker manager + reverse proxy +
> database panel + monitoring.**

Для небольшой infrastructure team:

> **Gateway заменяет Komodo + Pangolin + Grafana/Loki + AWX + Smallstep CA.**

Для enterprise Docker:

> **Gateway заменяет Portainer Business + Vault + Smallstep CA + Rundeck +
> централизованный logging stack.**

Для AI-позиционирования:

> **Gateway объединяет OpsPilot-подобный AI interface, Portainer-подобный resource
> control и Rundeck-подобное подтверждаемое исполнение.**

Последняя формулировка требует оговорки: Gateway не заменяет полноценный
OpenTelemetry APM и continuous RCA OpsPilot.

## Capability-To-Product Mapping

| Возможность Gateway | Обычно требует отдельного продукта |
|---|---|
| Docker fleet и container lifecycle | Portainer, Dockhand или Komodo |
| Git/deployment workflows | Coolify, Dokploy или Easypanel |
| Nginx ingress и TLS | Nginx Proxy Manager или Traefik |
| Private connectivity / Secure Links | Pangolin или Cloudflare Tunnel |
| Monitoring | Prometheus + Grafana, Netdata или Zabbix |
| Structured logging | Loki, Graylog или отдельный ClickHouse UI |
| Database explorer | pgAdmin + RedisInsight + ClickHouse client |
| Managed databases и application bindings | PaaS database services плюс custom networking/secrets |
| Internal PKI | Smallstep CA |
| Secrets | Vault или отдельный Docker Secrets UI |
| Runbook automation | Rundeck, AWX или Semaphore |
| RBAC и audit | Платные версии container managers плюс SIEM tooling |
| AI operations | Kubiya, OpsPilot, Robusta или RunWhen |
| Model gateway | LiteLLM/OpenRouter-подобный отдельный слой |

Максимальная формула консолидации:

> **Gateway = Portainer + Coolify + Nginx Proxy Manager + Pangolin + Grafana +
> pgAdmin/RedisInsight + Smallstep CA + Rundeck + LiteLLM — в единой resource model,
> RBAC и audit boundary.**

Для публичного маркетинга лучше использовать менее перегруженную версию:

> **One self-hosted control plane instead of separate tools for containers,
> ingress, databases, monitoring, PKI and AI operations.**

## What Gateway Does Not Replace

Gateway не следует позиционировать как замену следующим категориям:

- Vercel CDN, edge/serverless runtime и preview ecosystem.
- Полноценный OpenTelemetry APM и distributed tracing OpsPilot.
- Kubernetes orchestration Rancher/OpenShift.
- Полноценный enterprise secrets manager уровня Vault.
- PagerDuty/Rootly как incident paging и coordination system.
- Зрелая backup-платформа до завершения Gateway Storage и database backup/restore.

## Recommended Primary Battle Card

Для основной battle card достаточно шести конкурентов:

1. **Komodo** — прямой Docker fleet/control-plane конкурент.
2. **Portainer** — enterprise container-management конкурент.
3. **Easypanel** — конкурент по time-to-value.
4. **RunCloud или ServerAvatar** — конкурент за small infrastructure team.
5. **Rancher** — enterprise/Kubernetes альтернатива.
6. **Kubiya** — конкурент за будущую категорию AI infrastructure operations.

Дополнительные situational battle cards:

- Coolify и Dokploy — для Git-first application teams.
- Dockhand — для пользователей, которым нужен лёгкий modern Docker UI.
- Cosmos Cloud — для homelab и private self-hosting.
- OpsPilot — для обсуждения observability и AI SRE.
- Vercel — как эталон developer experience, а не прямой infrastructure competitor.

## Strategic Conclusions

1. Gateway не следует продавать только как «альтернативу Portainer». Это искусственно
   сужает продукт до container UI.
2. Главная ценность Gateway — единая resource model, permission boundary и audit
   trail для операций, которые иначе распределены между несколькими продуктами.
3. Наиболее прямой технический конкурент — Komodo.
4. Наиболее опасные конкуренты по onboarding и developer experience — Coolify,
   Dokploy и Easypanel.
5. Наиболее опасный зрелый enterprise-конкурент — Portainer.
6. Наиболее важный будущий AI-конкурент — Kubiya.
7. Vercel задаёт ожидания от deployment UX, но не заменяет self-hosted control plane.
8. Gateway выгоднее интегрировать с OTel/APM и incident products, чем строить полный
   observability stack с нуля.

## Sources

### Gateway

- [Gateway README](README.md)
- [Gateway capabilities](docs/capabilities.md)
- [Gateway licensing](docs/licensing.md)
- [Gateway security model](docs/security.md)

### Competitors

- [Portainer features](https://www.portainer.io/features)
- [Dockhand](https://dockhand.pro/)
- [Dokploy features](https://docs.dokploy.com/docs/core/features)
- [Coolify introduction](https://coolify.io/docs/get-started/introduction)
- [Vercel pricing and capabilities](https://vercel.com/pricing)
- [Vercel MCP](https://vercel.com/docs/agent-resources/vercel-mcp)
- [Komodo](https://komo.do/)
- [Easypanel](https://easypanel.io/)
- [Easypanel pricing](https://easypanel.io/pricing)
- [CapRover](https://caprover.com/)
- [Cosmos Cloud](https://cosmos-cloud.io/)
- [Cloudron](https://www.cloudron.io/)
- [Dockge](https://github.com/louislam/dockge)
- [Rancher](https://ranchermanager.docs.rancher.com/v2.14)
- [Kubiya](https://www.kubiya.ai/platform)
- [RunCloud](https://runcloud.io/)
- [ServerAvatar](https://serveravatar.com/docs/intro/)
- [Plesk](https://www.plesk.com/)
- [Enhance](https://enhance.com/)
- [CloudPanel](https://www.cloudpanel.io/)
- [OpsPilot](https://opspilot.com/)
- [OpsPilot Coworker](https://docs.opspilot.com/Data-insights/Features/OpsPilot/Coworker/overview/)
- [OpsPilot MCP](https://docs.opspilot.com/Monitor-your-data/MCP/mcp-overview/)
- [Robusta](https://docs.robusta.dev/holmes_button/)
- [RunWhen Skills Registry](https://registry.runwhen.com/)
- [Rundeck](https://www.rundeck.com/)
- [AWX](https://github.com/ansible/awx)
- [Pangolin](https://docs.pangolin.net/about/how-pangolin-works)
