# Alerts and notification templates

## Alert rules

An alert rule has:

- `category`: `node`, `container`, `build`, `compose`, `proxy`, `pages`, `gateway`, `logging`, `integration`, `certificate`, `security`, `database_postgres`, `database_clickhouse`, or `database_redis`;
- `type`: `threshold` (`metric`, `operator`, `thresholdValue`, `durationSeconds`, `fireThresholdPercent`, `resolveAfterSeconds`, `resolveThresholdPercent`) or `event` (`eventPattern`);
- `resourceIds`: the resources in scope; empty means every matching resource;
- `severity`, a Handlebars message template, and `cooldownSeconds` (default 900).

`GET /api/notifications/alert-rules/categories` is the authoritative list of each category's metrics, events, and template variables. Read it before writing a rule or template instead of guessing field names.

## Webhooks

A webhook has a URL, method, a Handlebars body template (Discord, Slack, Telegram, generic JSON, and plain-text presets), custom headers, optional HMAC-SHA256 signing, and retry with backoff. `list_webhook_deliveries` and `get_delivery_stats` show results; `test_webhook` sends a test.

Webhook URLs and headers often embed credentials. `notifications:webhooks:manage` reveals them; never repeat them in chat, and never ask the user to paste a signing secret or token URL into chat. Let the user enter those in the Console.

## Template variables

Variables are namespaced: `{{notification.*}}`, `{{alert.*}}`, `{{resource.*}}`, `{{metric.*}}`, `{{node.*}}`, `{{certificate.*}}`, `{{state.*}}`, `{{event.*}}`, `{{operation.*}}`, `{{failure.*}}`, `{{details.*}}`, `{{fired.*}}`, `{{resolution.*}}`, and `{{gateway.url}}`. Legacy flat names such as `alert_name`, `severity`, or `value` are not aliases and render empty without an error.

Helpers:

- comparison: `eq`, `ne`, `gt`, `lt`, `gte`, `lte`, `and`, `or`, `not`;
- formatting: `round`, `uppercase`, `lowercase`, `truncate`, `json`, `default`, `coalesce`, `join`;
- math: `math`, `percent`;
- time: `formatDuration`, `timeago`, `dateformat`;
- text: `pluralize`.

## Scopes

`notifications:alerts:view|manage` and `notifications:webhooks:view|manage` (manage also reveals URLs and headers and implies view).
