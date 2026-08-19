---
{
  "id": "ifp3c48s",
  "file_name": "ifp3c48s_opencodex_inference_migration",
  "tags": [
    "accounting",
    "inference",
    "opencodex",
    "review-lessons",
    "websocket"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1787137855135,
  "updated_at": 1787137855135
}
---
План 08-19-opencodex-inference-core завершён (2026-08-19): кастомный inference-движок Gateway заменён на управляемый OpenCodex core (контейнер inference-core:10100, внутренняя docker-сеть, без публикации портов). Gateway = control plane: auth gwi_, модели, лимиты, прайсинг, accounting через HMAC-callbacks на :9410 (не публикуется). Data plane: прозрачный прокси /api/inference/v1/* с подписанным контекстом wiolett-core/v1 (rootRequestId === request row id, строка создаётся ДО подписи). WS — per-turn прокси: core держит сокет multi-turn, поэтому прокси сам закрывает upstream по терминальному событию, иначе ход клинивает. Concurrency lease держится весь ход, release в finalizeTurn. Уроки ревью: (1) при моках db в тестах легко замаскировать потерю поля — API-биллинг шёл в ноль из-за несохранённого pricingSnapshotId, тесты были зелёные; (2) идемпотентные redelivery-ответы должны replay'ить сохранённые решения (admittedMaxOutputTokens колонка); (3) клиенту-недоставленные oversized ответы сеттлятся как failed, иначе начисление за недоставку. Harness-роуты /api/inference/codex|anthropic и toggle удалены; единый base URL /api/inference/v1. Lab E2E отложен на lab-хост (план строка 218). Доказательства: .workflow/plans/08-19-opencodex-inference-core/artifacts/verification-t7.md.
