-- An alert rule's resolve message: the message sent when its alert resolves. Empty (NULL, every existing rule) uses
-- Gateway's resolve text for the rule, such as "Proxy host example.com is back online", instead of the firing message.
ALTER TABLE "notification_alert_rules" ADD COLUMN "resolve_message_template" text;
