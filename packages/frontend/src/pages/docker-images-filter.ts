import { isInternalAvailabilityImage } from "@/lib/docker-image-visibility";
import type { DockerImage } from "@/types";

export function filterDockerImages<T extends DockerImage>(
  images: T[],
  search: string,
  filterUsage: string
): T[] {
  let result = images
    .map((image) => {
      const tags: string[] = (image as any).repoTags ?? (image as any).RepoTags ?? [];
      const visibleTags = tags.filter((tag) => !isInternalAvailabilityImage(tag));
      if (visibleTags.length === tags.length) return image;
      if (Array.isArray((image as any).repoTags)) return { ...image, repoTags: visibleTags };
      return { ...image, RepoTags: visibleTags };
    })
    .filter((image) => {
      const tags = (image as any).repoTags ?? (image as any).RepoTags ?? [];
      return tags.length > 0 && !tags.every((tag: string) => tag === "<none>:<none>");
    });
  if (filterUsage === "used") {
    result = result.filter(
      (image) => ((image as any).containers ?? (image as any).Containers ?? -1) > 0
    );
  } else if (filterUsage === "unused") {
    result = result.filter(
      (image) => ((image as any).containers ?? (image as any).Containers ?? -1) === 0
    );
  }
  if (search) {
    const query = search.toLowerCase();
    result = result.filter((image) => {
      const tags = (image as any).repoTags ?? (image as any).RepoTags ?? [];
      const id = (image as any).id ?? (image as any).Id ?? "";
      return (
        id.toLowerCase().includes(query) ||
        tags.some((tag: string) => tag.toLowerCase().includes(query))
      );
    });
  }
  return result;
}
