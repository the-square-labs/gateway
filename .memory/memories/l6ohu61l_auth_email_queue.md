---
{
  "id": "l6ohu61l",
  "file_name": "l6ohu61l_auth_email_queue",
  "tags": [
    "authentication",
    "bullmq",
    "email",
    "gateway",
    "redis"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1785703080824,
  "updated_at": 1785703080824
}
---
Gateway authentication email delivery is implemented by AuthEmailQueueService using a BullMQ queue named auth-email-delivery, created during backend bootstrap. Password setup/reset and email OTP requests enqueue encrypted payloads (encrypted by CryptoService). The worker decrypts payloads only immediately before SMTP delivery, retries failed deliveries up to 3 times with exponential backoff, removes successful jobs, and retains a bounded set of failed encrypted jobs. The worker is closed before Redis is shut down during application shutdown. SMTP configuration verification remains synchronous because only a confirmed delivery may set auth:smtp.verifiedAt. AuthService.listUsers() must include the authMethod field; omitting it causes the frontend to default user rows/dialogs to OIDC even when users.auth_method is persisted.
