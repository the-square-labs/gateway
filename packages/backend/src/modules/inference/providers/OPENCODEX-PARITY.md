# OpenCodex connector coverage

Reference: `lidge-jun/opencodex` commit `357acee62458684bc027e9d524e95bd066df3a43`.

Gateway carries the provider registry and protocol behavior into an isolated inference bounded context. The registry covers OpenAI/Codex, Anthropic, xAI, Kimi/Moonshot, Google Gemini, Google Antigravity, GitHub Copilot, Umans, OpenCode, NeuralWatt, OrcaRouter, DeepSeek, Fire Pass, NVIDIA, Z.AI, SiliconFlow, Qwen, Tencent, Alibaba, ZenMux, LiteLLM, Ollama, vLLM, LM Studio, MiniMax, MiMo, Cloudflare Workers AI, OpenRouter, Groq, Cerebras, Together, Hugging Face, Mistral, Azure OpenAI, and generic OpenAI-compatible endpoints.

Supported shared surfaces are OpenAI Responses, Chat Completions, Anthropic Messages, model discovery, streaming/tool/reasoning translation, subscription quota sync where an upstream quota API exists, OAuth/API-key credential rotation, images, hosted search, Responses WebSocket, and HTTP realtime call proxying. Realtime sideband/audio WebSockets are intentionally excluded from this release. Google Antigravity uses Cloud Code Assist project discovery and its request envelope. Provider-specific capabilities remain explicit in the registry, so an unavailable surface fails closed instead of silently using the wrong wire format.

Cursor and Kiro are intentionally excluded from this release. OpenCodex desktop/service installation, Codex configuration mutation, and unsafe provider-driven local execution are also out of scope because Gateway is a remote multi-user service.
