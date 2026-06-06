export interface Env {
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_TOKEN?: string;
  // Set to "true" to skip proxying and return browser_download_url directly
  PUBLIC_REPO?: string;
}

interface GithubAsset {
  id: number;
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  body: string | null;
  published_at: string;
  assets: GithubAsset[];
}

interface UpdateResponse {
  version: string;
  notes: string;
  pub_date: string;
  url: string;
  signature: string;
}

// Tauri v2 target: "linux" | "windows" | "darwin"
// Tauri v2 arch:   "x86_64" | "aarch64"
function findAsset(
  assets: GithubAsset[],
  target: string,
  arch: string
): { archive: GithubAsset; sig: GithubAsset } | null {
  const archivePatterns: Record<string, Record<string, RegExp>> = {
    linux: {
      x86_64: /Voltius_[\d.]+_amd64\.AppImage$/,
      aarch64: /Voltius_[\d.]+_aarch64\.AppImage$/,
    },
    windows: {
      x86_64: /Voltius_[\d.]+_x64-setup\.exe$/,
      aarch64: /Voltius_[\d.]+_arm64-setup\.exe$/,
    },
    darwin: {
      x86_64: /Voltius_x64\.app\.tar\.gz$/,
      aarch64: /Voltius_aarch64\.app\.tar\.gz$/,
    },
  };

  const pattern = archivePatterns[target]?.[arch];
  if (!pattern) return null;

  const archive = assets.find((a) => pattern.test(a.name));
  if (!archive) return null;

  const sig = assets.find((a) => a.name === archive.name + ".sig");
  if (!sig) return null;

  return { archive, sig };
}

function stripV(tag: string): string {
  return tag.replace(/^v/, "");
}

// Simple semver comparison — returns true if `latest` > `current`
function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => parseInt(n, 10));
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const ghHeaders: HeadersInit = {
      "User-Agent": "tauri-update-server/1.0",
      Accept: "application/vnd.github+json",
    };
    if (env.GITHUB_TOKEN) {
      ghHeaders["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
    }

    const isPublic = env.PUBLIC_REPO === "true";

    // GET /v1/download/:assetId — proxied asset stream (private repo only)
    const downloadMatch = url.pathname.match(/^\/v1\/download\/(\d+)$/);
    if (!isPublic && downloadMatch) {
      const assetId = downloadMatch[1];
      const assetRes = await fetch(
        `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/assets/${assetId}`,
        { headers: { ...ghHeaders, Accept: "application/octet-stream" }, redirect: "follow" }
      );
      if (!assetRes.ok) {
        return new Response("Asset not found", { status: 404 });
      }
      return new Response(assetRes.body, {
        headers: {
          "Content-Type": assetRes.headers.get("Content-Type") ?? "application/octet-stream",
          "Content-Length": assetRes.headers.get("Content-Length") ?? "",
        },
      });
    }

    // GET /v1/:target/:arch/:currentVersion
    const match = url.pathname.match(/^\/v1\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (!match) {
      return new Response("Not found", { status: 404 });
    }

    const [, target, arch, currentVersion] = match;

    const releaseRes = await fetch(
      `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/latest`,
      { headers: ghHeaders, cf: { cacheTtl: 300, cacheEverything: true } }
    );

    if (!releaseRes.ok) {
      return new Response("Failed to fetch release", { status: 502 });
    }

    const release: GithubRelease = await releaseRes.json();
    const latestVersion = stripV(release.tag_name);

    if (!isNewer(latestVersion, currentVersion)) {
      return new Response(null, { status: 204 });
    }

    const found = findAsset(release.assets, target, arch);
    if (!found) {
      return new Response(null, { status: 204 });
    }

    // Fetch .sig via API (works for private repos)
    const sigRes = await fetch(
      `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/assets/${found.sig.id}`,
      { headers: { ...ghHeaders, Accept: "application/octet-stream" }, redirect: "follow" }
    );
    if (!sigRes.ok) {
      return new Response("Failed to fetch signature", { status: 502 });
    }
    const signature = await sigRes.text();

    const downloadUrl = isPublic
      ? found.archive.browser_download_url
      : `${url.protocol}//${url.host}/v1/download/${found.archive.id}`;

    const body: UpdateResponse = {
      version: latestVersion,
      notes: release.body ?? "",
      pub_date: release.published_at,
      url: downloadUrl,
      signature: signature.trim(),
    };

    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
