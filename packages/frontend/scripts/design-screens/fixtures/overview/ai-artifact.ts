/** A file the assistant produced in its sandbox, opened in the artifact pop-out. */
import { HttpResponse, http } from "msw";
import { uuid } from "../time";

export const AI_ARTIFACT_ID = uuid(24101);
export const AI_ARTIFACT_FILENAME = "grafana-incident-report.md";

export const aiArtifactText = `# grafana.example.com degraded — incident report

## Summary
The grafana container on Apps 2 ran at its 1.5 GiB memory limit, so health checks
answered in 1.2–1.9 s and the route was marked degraded for 40 minutes.

## Timeline (UTC)
- 09:40 analytics data source starts timing out
- 09:52 route health turns degraded
- 10:31 memory limit raised to 2 GiB, container restarted
- 10:33 health checks back under 200 ms

## Follow-up
- Retry the certificate renewal for grafana.example.com (expires in 8 days)
- Add a memory alert at 85% for the grafana container
`;

export function aiArtifactHandlers() {
  return [
    http.get("*/api/ai/sandbox/artifacts/:id/download", ({ params }) =>
      params.id === AI_ARTIFACT_ID
        ? new HttpResponse(aiArtifactText, { headers: { "Content-Type": "text/markdown" } })
        : HttpResponse.json({ message: "Not found" }, { status: 404 })
    ),
  ];
}
