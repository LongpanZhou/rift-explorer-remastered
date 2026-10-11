/**
 * Download count, shown top right: the total downloads of every release file, as GitHub
 * counts them. Read from GitHub's public releases API; nothing about the user is sent.
 */

/** Releases are published here; their file downloads are counted by GitHub. */
const RELEASES_API = "https://api.github.com/repos/LongpanZhou/rift-explorer-remastered/releases?per_page=100";

/** Total downloads of every release file, as GitHub counts them. Null when GitHub cannot be reached. */
export async function fetchDownloadCount(): Promise<number | null> {
  const res = await fetch(RELEASES_API, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) return null;
  const releases = (await res.json()) as { assets?: { download_count?: number }[] }[];
  if (!Array.isArray(releases)) return null;
  return releases.flatMap((r) => r.assets ?? []).reduce((sum, a) => sum + (a.download_count ?? 0), 0);
}
