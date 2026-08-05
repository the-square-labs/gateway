---
{
  "id": "vvdi4727",
  "file_name": "vvdi4727_gateway_logging_fix",
  "tags": [
    "gateway",
    "logging",
    "security",
    "system-config",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1782933272490,
  "updated_at": 1782933272490
}
---
In the WIOlett gateway project at /Users/knownout/Projects/wiolett/gateway, the public GET /api/logging/status endpoint was removed because it exposed ClickHouse/logging runtime metadata and the SDK does not use it. The frontend logging feature flag is now sourced from authenticated GET /api/system/config as features.loggingEnabled, computed via LoggingFeatureService.isEnabled(), and is not editable via GeneralSettingsService. Logging ingest endpoints remain publicly accessible with token authentication and gate on whether logging is enabled; protected logging UI/API routes use path-specific feature gating so that unknown /api/logging/* routes do not reveal the enabled/disabled state. Regression tests verify that unauthenticated and authenticated /api/logging/status calls do not disclose state, and end-to-end helpers rely on system config rather than logging status.
