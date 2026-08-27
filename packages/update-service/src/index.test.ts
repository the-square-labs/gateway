import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "./index.js";

const env = {
	GITHUB_OWNER: "the-square-labs",
	GITHUB_GATEWAY_REPO: "gateway",
	GITHUB_INFERENCE_CORE_REPO: "inference-core",
	GITHUB_INFERENCE_CORE_TOKEN: "private-core-token",
} as Env;

function release(tag_name: string) {
	return {
		tag_name,
		name: tag_name,
		body: "",
		html_url: `https://github.com/the-square-labs/gateway/releases/tag/${tag_name}`,
		published_at: "2026-08-27T00:00:00Z",
		draft: false,
		prerelease: false,
		assets: [],
	};
}

describe("gateway update facade", () => {
	it("serves health without contacting GitHub", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const response = await handleRequest(
			new Request("https://updates.thesqlabs.com/health"),
			env,
			fetcher,
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			service: "gateway-updates",
		});
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("normalizes public GitHub releases for Gateway clients", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json([
					{
						tag_name: "v2.9.11",
						name: "Gateway v2.9.11",
						body: "Release notes",
						html_url:
							"https://github.com/the-square-labs/gateway/releases/tag/v2.9.11",
						published_at: "2026-08-27T00:00:00Z",
						draft: false,
						prerelease: false,
						assets: [],
					},
				]),
			)
			.mockResolvedValueOnce(
				Response.json([
					{
						tag_name: "v2.25.0-wiolett.21",
						name: "Inference Core v2.25.0-wiolett.21",
						body: "Core release notes",
						html_url:
							"https://github.com/the-square-labs/inference-core/releases/tag/v2.25.0-wiolett.21",
						published_at: "2026-08-27T00:00:00Z",
						draft: false,
						prerelease: false,
						assets: [],
					},
				]),
			);
		const response = await handleRequest(
			new Request("https://updates.thesqlabs.com/gateway/releases"),
			env,
			fetcher,
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual([
			expect.objectContaining({
				tag_name: "v2.9.11",
				description: "Release notes",
			}),
			expect.objectContaining({
				tag_name: "v2.25.0-wiolett.21",
				description: "Core release notes",
			}),
		]);
		const gatewayHeaders = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
		const coreHeaders = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
		expect(gatewayHeaders.get("Authorization")).toBe(
			"Bearer private-core-token",
		);
		expect(coreHeaders.get("Authorization")).toBe("Bearer private-core-token");
	});

	it.each([
		["v1.1.9", "v1.1.12", "patch"],
		["v1.1.12", "v1.2.0", "minor-baseline"],
		["v1.2.0", "v1.2.1", "patch"],
	])("stages Gateway updates from %s to %s", async (current, target, reason) => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json([
					release("v1.1.12"),
					release("v1.2.0"),
					release("v1.2.1"),
					release("v2.0.0"),
				]),
			);
		const response = await handleRequest(
			new Request(
				`https://updates.thesqlabs.com/gateway/releases?component=gateway&current=${current}`,
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			component: "gateway",
			current,
			reason,
			target: { tag_name: target },
		});
	});

	it("does not automatically cross a major version", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json([release("v2.0.0")]));
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=gateway&current=v1.9.9",
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(204);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("returns the latest inference core build directly", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json([
					release("v2.25.0-wiolett.21"),
					release("v2.26.0-wiolett.1"),
				]),
			);
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=inference-core&current=v2.24.0-wiolett.9",
			),
			env,
			fetcher,
		);
		await expect(response.json()).resolves.toMatchObject({
			reason: "latest",
			target: { tag_name: "v2.26.0-wiolett.1" },
		});
	});

	it("returns the latest component release when current is omitted", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json([release("v1.2.0-relay"), release("v1.2.1-relay")]),
			);
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=relay",
			),
			env,
			fetcher,
		);
		await expect(response.json()).resolves.toMatchObject({
			reason: "latest",
			target: { tag_name: "v1.2.1-relay" },
		});
	});

	it("does not keep the legacy root release path", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const response = await handleRequest(
			new Request("https://updates.thesqlabs.com/releases"),
			env,
			fetcher,
		);
		expect(response.status).toBe(404);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects paths outside the release contract without upstream access", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/gateway/v2.9.11/../../secrets",
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(404);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("streams a release asset and does not forward GitHub authorization to the signed redirect", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					tag_name: "v2.9.11",
					name: null,
					body: null,
					html_url:
						"https://github.com/the-square-labs/gateway/releases/tag/v2.9.11",
					published_at: "2026-08-27T00:00:00Z",
					draft: false,
					prerelease: false,
					assets: [
						{
							id: 123,
							name: "gateway-image.update.json",
							size: 7,
							content_type: "application/json",
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: {
						Location:
							"https://release-assets.githubusercontent.com/signed-download",
					},
				}),
			)
			.mockResolvedValueOnce(
				new Response("payload", {
					headers: { "Content-Type": "application/json" },
				}),
			);

		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/gateway/v2.9.11/gateway-image.update.json",
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe("payload");
		const redirectHeaders = new Headers(fetcher.mock.calls[2]?.[1]?.headers);
		expect(redirectHeaders.has("Authorization")).toBe(false);
	});

	it("answers HEAD from release metadata without downloading the asset", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				tag_name: "v2.9.11-docker",
				name: null,
				body: null,
				html_url:
					"https://github.com/the-square-labs/gateway/releases/tag/v2.9.11-docker",
				published_at: "2026-08-27T00:00:00Z",
				draft: false,
				prerelease: false,
				assets: [
					{
						id: 456,
						name: "docker-daemon-linux-amd64",
						size: 1024,
						content_type: "application/octet-stream",
					},
				],
			}),
		);
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/docker-daemon/v2.9.11-docker/docker-daemon-linux-amd64",
				{
					method: "HEAD",
				},
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Length")).toBe("1024");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("reads inference core assets from the private core repository", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				tag_name: "v2.25.0-wiolett.21",
				name: null,
				body: null,
				html_url:
					"https://github.com/the-square-labs/inference-core/releases/tag/v2.25.0-wiolett.21",
				published_at: "2026-08-27T00:00:00Z",
				draft: false,
				prerelease: false,
				assets: [
					{
						id: 789,
						name: "opencodex-image.update.json",
						size: 2048,
						content_type: "application/json",
					},
				],
			}),
		);
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/inference-core/v2.25.0-wiolett.21/opencodex-image.update.json",
				{ method: "HEAD" },
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(200);
		expect(fetcher.mock.calls[0]?.[0]).toBe(
			"https://api.github.com/repos/the-square-labs/inference-core/releases/tags/v2.25.0-wiolett.21",
		);
		const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
		expect(headers.get("Authorization")).toBe("Bearer private-core-token");
	});
});
