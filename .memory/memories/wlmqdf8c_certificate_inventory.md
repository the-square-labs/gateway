---
{
  "id": "wlmqdf8c",
  "file_name": "wlmqdf8c_certificate_inventory",
  "tags": [
    "frontend",
    "pki",
    "ssl",
    "tables",
    "virtualization"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1785946661667,
  "updated_at": 1785946661667
}
---
For large PKI and SSL certificate inventories, use the shared `DataTable` inside a fixed-height container. It owns the virtualized body and scroll container. Keep the API's page/limit contract in the store, append pages through `fetchNextPage`, and use an `IntersectionObserver` sentinel with the DataTable scroll ref to request the next page. Reset accumulated rows and the next-page state when filters or the system-certificate visibility change. Do not show Previous/Next pagination controls. Keep small CA detail previews as `SimpleTable`; request at most 10 leaf certificates and expose the shared dashboard-style `View all` link in the PanelShell header. Use shared `Badge` for CA key algorithm, CA certificate count, and PKI certificate type.
