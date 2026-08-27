const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "gateway-update-facade";
const RELEASE_LIST_LIMIT_BYTES = 2 * 1024 * 1024;
const PRODUCT_NAMESPACE = "gateway";

type Fetcher = typeof fetch;

interface GitHubReleaseAsset {
	id: number;
	name: string;
	size: number;
	content_type: string;
}

interface GitHubRelease {
	tag_name: string;
	name: string | null;
	body: string | null;
	html_url: string;
	published_at: string | null;
	draft: boolean;
	prerelease: boolean;
	assets: GitHubReleaseAsset[];
}

interface NormalizedRelease {
	tag_name: string;
	name: string;
	description: string;
	body: string;
	html_url: string;
	published_at: string | null;
	prerelease: boolean;
	_links: { self: string };
}

const TAG_PATTERNS: Readonly<Record<string, RegExp>> = {
	gateway: /^v\d+\.\d+\.\d+$/,
	relay: /^v\d+\.\d+\.\d+-relay$/,
	"nginx-daemon": /^v\d+\.\d+\.\d+-nginx$/,
	"docker-daemon": /^v\d+\.\d+\.\d+-docker$/,
	"monitoring-daemon": /^v\d+\.\d+\.\d+-monitoring$/,
	"relay-supervisor": /^v\d+\.\d+\.\d+-relay$/,
	"inference-core": /^v\d+\.\d+\.\d+-wiolett\.\d+$/,
};

const ARTIFACT_PATTERNS: Readonly<Record<string, RegExp>> = {
	gateway: /^gateway-image\.update\.json$/,
	relay: /^relay-image\.update\.json$/,
	"nginx-daemon":
		/^(nginx-daemon-linux-(amd64|arm64)(\.update\.json)?|checksums\.txt)$/,
	"docker-daemon":
		/^(docker-daemon-linux-(amd64|arm64)(\.update\.json)?|checksums\.txt)$/,
	"monitoring-daemon":
		/^(monitoring-daemon-linux-(amd64|arm64)(\.update\.json)?|checksums\.txt)$/,
	"relay-supervisor":
		/^(relay-(supervisor|worker)-linux-(amd64|arm64)(\.update\.json)?|checksums\.txt)$/,
	"inference-core": /^opencodex-image\.update\.json$/,
};

interface GitHubRepository {
	name: string;
	token?: string;
}

function jsonResponse(
	body: unknown,
	status = 200,
	cacheControl = "no-store",
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": cacheControl,
			"Access-Control-Allow-Origin": "*",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

function githubHeaders(
	repository: GitHubRepository,
	accept = "application/vnd.github+json",
): Headers {
	const headers = new Headers({
		Accept: accept,
		"User-Agent": USER_AGENT,
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
	});
	if (repository.token)
		headers.set("Authorization", `Bearer ${repository.token}`);
	return headers;
}

function githubApiUrl(
	env: Env,
	repository: GitHubRepository,
	path: string,
): string {
	return `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(repository.name)}${path}`;
}

function gatewayRepository(env: Env): GitHubRepository {
	return {
		name: env.GITHUB_GATEWAY_REPO,
		token: env.GITHUB_INFERENCE_CORE_TOKEN,
	};
}

function inferenceCoreRepository(env: Env): GitHubRepository {
	return {
		name: env.GITHUB_INFERENCE_CORE_REPO,
		token: env.GITHUB_INFERENCE_CORE_TOKEN,
	};
}

function repositoryForPackage(env: Env, packageName: string): GitHubRepository {
	return packageName === "inference-core"
		? inferenceCoreRepository(env)
		: gatewayRepository(env);
}

async function readBoundedJson<T>(response: Response): Promise<T> {
	const contentLength = Number(response.headers.get("Content-Length") ?? "0");
	if (contentLength > RELEASE_LIST_LIMIT_BYTES)
		throw new Error("GitHub metadata response is too large");
	const body = await response.text();
	if (body.length > RELEASE_LIST_LIMIT_BYTES)
		throw new Error("GitHub metadata response is too large");
	return JSON.parse(body) as T;
}

function normalizeRelease(release: GitHubRelease): NormalizedRelease {
	const description = release.body ?? "";
	return {
		tag_name: release.tag_name,
		name: release.name ?? release.tag_name,
		description,
		body: description,
		html_url: release.html_url,
		published_at: release.published_at,
		prerelease: release.prerelease,
		_links: { self: release.html_url },
	};
}

async function handleReleaseList(
	env: Env,
	fetcher: Fetcher,
): Promise<Response> {
	const repositories = [gatewayRepository(env), inferenceCoreRepository(env)];
	const upstreams = await Promise.all(
		repositories.map((repository) =>
			fetcher(githubApiUrl(env, repository, "/releases?per_page=100"), {
				headers: githubHeaders(repository),
			}),
		),
	);
	for (let index = 0; index < upstreams.length; index += 1) {
		const upstream = upstreams[index];
		if (upstream?.ok) continue;
		console.error(
			JSON.stringify({
				event: "github_releases_failed",
				repository: repositories[index]?.name,
				status: upstream?.status,
			}),
		);
		return jsonResponse({ error: "release_source_unavailable" }, 502);
	}
	const releases = (
		await Promise.all(
			upstreams.map((upstream) => readBoundedJson<GitHubRelease[]>(upstream)),
		)
	).flat();
	return jsonResponse(
		releases
			.filter((release) => !release.draft && !release.prerelease)
			.map(normalizeRelease),
		200,
		"public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
	);
}

function parseArtifactPath(
	pathname: string,
): { packageName: string; tag: string; artifactName: string } | null {
	const segments = pathname.split("/").filter(Boolean);
	if (segments.length !== 4 || segments[0] !== PRODUCT_NAMESPACE) return null;
	const [, packageName, tag, artifactName] = segments.map((segment) =>
		decodeURIComponent(segment),
	);
	if (!packageName || !tag || !artifactName) return null;
	const tagPattern = TAG_PATTERNS[packageName];
	const artifactPattern = ARTIFACT_PATTERNS[packageName];
	if (!tagPattern?.test(tag) || !artifactPattern?.test(artifactName))
		return null;
	return { packageName, tag, artifactName };
}

function isTrustedAssetRedirect(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	return (
		url.protocol === "https:" &&
		(url.hostname === "github.com" ||
			url.hostname === "objects.githubusercontent.com" ||
			url.hostname.endsWith(".githubusercontent.com"))
	);
}

function copyAssetHeaders(
	upstream: Response,
	asset: GitHubReleaseAsset,
): Headers {
	const headers = new Headers({
		"Content-Type":
			upstream.headers.get("Content-Type") ??
			asset.content_type ??
			"application/octet-stream",
		"Content-Disposition":
			upstream.headers.get("Content-Disposition") ??
			`attachment; filename="${asset.name.replaceAll('"', "")}"`,
		"Cache-Control": "public, max-age=3600, s-maxage=31536000, immutable",
		"Access-Control-Allow-Origin": "*",
		"X-Content-Type-Options": "nosniff",
	});
	for (const name of [
		"Content-Length",
		"Content-Range",
		"Accept-Ranges",
		"ETag",
		"Last-Modified",
	]) {
		const value = upstream.headers.get(name);
		if (value) headers.set(name, value);
	}
	return headers;
}

async function fetchAssetBinary(
	request: Request,
	env: Env,
	repository: GitHubRepository,
	asset: GitHubReleaseAsset,
	fetcher: Fetcher,
): Promise<Response> {
	if (request.method === "HEAD") {
		return new Response(null, {
			headers: {
				"Content-Type": asset.content_type || "application/octet-stream",
				"Content-Length": String(asset.size),
				"Content-Disposition": `attachment; filename="${asset.name.replaceAll('"', "")}"`,
				"Cache-Control": "public, max-age=3600, s-maxage=31536000, immutable",
				"Access-Control-Allow-Origin": "*",
				"X-Content-Type-Options": "nosniff",
			},
		});
	}

	const range = request.headers.get("Range");
	const apiHeaders = githubHeaders(repository, "application/octet-stream");
	if (range) apiHeaders.set("Range", range);
	const assetResponse = await fetcher(
		githubApiUrl(env, repository, `/releases/assets/${asset.id}`),
		{
			headers: apiHeaders,
			redirect: "manual",
		},
	);

	let binaryResponse = assetResponse;
	if (assetResponse.status >= 300 && assetResponse.status < 400) {
		const location = assetResponse.headers.get("Location");
		if (!location || !isTrustedAssetRedirect(location)) {
			console.error(
				JSON.stringify({
					event: "github_asset_redirect_rejected",
					assetId: asset.id,
				}),
			);
			return jsonResponse({ error: "release_asset_unavailable" }, 502);
		}
		const redirectHeaders = new Headers();
		if (range) redirectHeaders.set("Range", range);
		binaryResponse = await fetcher(location, {
			headers: redirectHeaders,
			redirect: "follow",
		});
	}

	if (!binaryResponse.ok && binaryResponse.status !== 206) {
		console.error(
			JSON.stringify({
				event: "github_asset_failed",
				assetId: asset.id,
				status: binaryResponse.status,
			}),
		);
		return jsonResponse({ error: "release_asset_unavailable" }, 502);
	}
	return new Response(binaryResponse.body, {
		status: binaryResponse.status,
		headers: copyAssetHeaders(binaryResponse, asset),
	});
}

async function handleArtifact(
	request: Request,
	env: Env,
	fetcher: Fetcher,
): Promise<Response> {
	let path: ReturnType<typeof parseArtifactPath>;
	try {
		path = parseArtifactPath(new URL(request.url).pathname);
	} catch {
		return jsonResponse({ error: "invalid_artifact_path" }, 400);
	}
	if (!path) return jsonResponse({ error: "artifact_not_found" }, 404);
	const repository = repositoryForPackage(env, path.packageName);

	const releaseResponse = await fetcher(
		githubApiUrl(
			env,
			repository,
			`/releases/tags/${encodeURIComponent(path.tag)}`,
		),
		{
			headers: githubHeaders(repository),
		},
	);
	if (releaseResponse.status === 404)
		return jsonResponse({ error: "release_not_found" }, 404);
	if (!releaseResponse.ok) {
		console.error(
			JSON.stringify({
				event: "github_release_failed",
				status: releaseResponse.status,
				tag: path.tag,
			}),
		);
		return jsonResponse({ error: "release_source_unavailable" }, 502);
	}
	const release = await readBoundedJson<GitHubRelease>(releaseResponse);
	const asset = release.assets.find(
		(candidate) => candidate.name === path.artifactName,
	);
	if (!asset) return jsonResponse({ error: "artifact_not_found" }, 404);
	return fetchAssetBinary(request, env, repository, asset, fetcher);
}

export async function handleRequest(
	request: Request,
	env: Env,
	fetcher: Fetcher = fetch,
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return jsonResponse({ error: "method_not_allowed" }, 405);
	}
	const pathname = new URL(request.url).pathname;
	if (pathname === "/health")
		return jsonResponse(
			{ ok: true, service: "gateway-updates" },
			200,
			"no-store",
		);
	if (pathname === "/gateway/releases") return handleReleaseList(env, fetcher);
	return handleArtifact(request, env, fetcher);
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await handleRequest(request, env);
		} catch (error) {
			console.error(
				JSON.stringify({
					event: "unhandled_request_error",
					error: error instanceof Error ? error.message : String(error),
				}),
			);
			return jsonResponse({ error: "internal_error" }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
